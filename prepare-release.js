#!/usr/bin/env node
// Usage: node prepare-release.js


require('dotenv').config();

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const SOURCE_REPO = process.env.RELEASE_SOURCE_REPO || 'octocatSupply';
const SOURCE_BRANCHES = (process.env.RELEASE_BRANCHES ||
  'main,feature-add-cart-page,feature-add-tos-download')
  .split(',')
  .map(branch => branch.trim())
  .filter(Boolean);

function releasePath(branch, relativePath = '') {
  return path.posix.join('demo-contents', SOURCE_REPO, branch, relativePath);
}

// ============================================================================
// CONFIGURATION - Update these variables for your customizations
// ============================================================================

const CONFIG = {
  // Input and output files
  inputTarball: process.env.INPUT_RELEASE_TARBALL || './source-release.tar.gz',
  outputTarball: process.env.OUTPUT_RELEASE_TARBALL || './release.tar.gz',
  
  // Working directory for extraction/repackaging
  workingDir: process.env.PREPARE_RELEASE_WORKING_DIR || './temp-prepare-release',

  requiredPaths: [
    '.octodemo/metadata.json',
    ...SOURCE_BRANCHES.map(branch => releasePath(branch))
  ],
  
  // Files/directories to remove (relative to extracted root)
  filesToRemove: SOURCE_BRANCHES.flatMap(branch => [
    releasePath(branch, 'CONTRIBUTING.md'),
    releasePath(branch, 'api-nodejs/ca.key')
  ]),

  demoDirectories: SOURCE_BRANCHES.map(branch => releasePath(branch, 'demo')),
  
  // Files to add or replace (key: destination path, value: source path or content)
  filesToAddOrReplace: Object.fromEntries(SOURCE_BRANCHES.flatMap(branch => [
    [
      releasePath(branch, 'README.md'),
      { type: 'file', source: './workshop-files/README.md' }
    ],
    [
      releasePath(branch, 'docs/workshop-agent-mode.md'),
      { type: 'file', source: './workshop-files/workshop-agent-mode.md' }
    ],
    [
      releasePath(branch, 'docs/workshop-use-case-focused.md'),
      { type: 'file', source: './workshop-files/workshop-use-case-focused.md' }
    ],
    [
      releasePath(branch, 'api-nodejs/.env.example'),
      { type: 'file', source: './workshop-files/API-.env.example' }
    ]
  ])),
  
  // Text replacements to apply to specific files
  textReplacements: {
    // Example: Replace text in README files
    // [releasePath('main', 'README.md')]: [
    //   { find: 'Internal Demo', replace: 'Customer Workshop' },
    //   { find: 'For GitHub SEs only', replace: '' }
    // ]
  }
};

// ============================================================================
// Release Preparation Class
// ============================================================================

class ReleasePreparer {
  constructor() {
    this.extractDir = path.join(CONFIG.workingDir, 'extracted');
  }

  async run() {
    console.log('🎯 Preparing Workshop Release Package...\n');
    
    try {
      await this.validateConfiguration();
      console.log(`📦 Input: ${CONFIG.inputTarball}`);
      console.log(`📦 Output: ${CONFIG.outputTarball}\n`);

      // Step 1: Extract the original tarball
      await this.extractTarball();
      await this.validateSourceRelease();

      // Step 2: Remove unwanted files/directories
      await this.removeFiles();
      await this.pruneDemoDirectories();

      // Step 3: Add or replace files
      await this.addOrReplaceFiles();

      // Step 4: Apply text replacements
      await this.applyTextReplacements();

      // Step 5: Validate and repackage as new tarball
      await this.validatePreparedRelease();
      await this.createTarball();
      await this.createChecksum();

      console.log('\n✅ Release package preparation completed successfully!');
      console.log(`📦 Workshop release: ${CONFIG.outputTarball}`);
      console.log(`🔐 SHA-256 checksum: ${CONFIG.outputTarball}.sha256`);
    } finally {
      await this.cleanup();
    }
  }

  async validateConfiguration() {
    if (!fs.existsSync(CONFIG.inputTarball)) {
      throw new Error(`Input tarball not found: ${CONFIG.inputTarball}`);
    }

    if (path.resolve(CONFIG.inputTarball) === path.resolve(CONFIG.outputTarball)) {
      throw new Error('Input and output tarballs must use different paths');
    }

    if (SOURCE_BRANCHES.length === 0) {
      throw new Error('At least one release branch must be configured');
    }

    for (const config of Object.values(CONFIG.filesToAddOrReplace)) {
      if (config.type === 'file' && !fs.existsSync(config.source)) {
        throw new Error(`Replacement source file not found: ${config.source}`);
      }
    }

    await fsPromises.mkdir(path.dirname(path.resolve(CONFIG.outputTarball)), { recursive: true });
  }

  async extractTarball() {
    console.log('📂 Extracting original release tarball...');
    
    // Clean up any existing working directory
    if (fs.existsSync(CONFIG.workingDir)) {
      await fsPromises.rm(CONFIG.workingDir, { recursive: true, force: true });
    }
    
    await fsPromises.mkdir(this.extractDir, { recursive: true });
    
    await tar.extract({
      file: CONFIG.inputTarball,
      cwd: this.extractDir,
      // Skip macOS AppleDouble resource fork files (._*) baked into tarballs
      filter: (p) => !p.replace(/^\.[\\/]/, '').split(/[\\/]/).filter(Boolean).some(part => part.startsWith('._'))
    });
    
    console.log('✅ Extracted successfully\n');
  }

  async validateSourceRelease() {
    const missingPaths = CONFIG.requiredPaths.filter(
      relativePath => !fs.existsSync(path.join(this.extractDir, relativePath))
    );

    if (missingPaths.length > 0) {
      throw new Error(`Source release is missing required paths:\n- ${missingPaths.join('\n- ')}`);
    }

    const metadataPath = path.join(this.extractDir, '.octodemo', 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8'));
    } catch (error) {
      throw new Error(`Source release has invalid .octodemo/metadata.json: ${error.message}`);
    }

    const repoConfig = metadata.demoContents?.[SOURCE_REPO];
    if (!repoConfig) {
      throw new Error(`Source release metadata does not define demoContents.${SOURCE_REPO}`);
    }

    const metadataBranches = new Set([
      repoConfig.mainBranch,
      ...(repoConfig.additionalBranches || [])
    ]);
    const unconfiguredBranches = SOURCE_BRANCHES.filter(branch => !metadataBranches.has(branch));
    if (unconfiguredBranches.length > 0) {
      throw new Error(
        `Configured branches are not declared in metadata:\n- ${unconfiguredBranches.join('\n- ')}`
      );
    }

    console.log('✅ Source release layout validated\n');
  }

  async removeFiles() {
    if (CONFIG.filesToRemove.length === 0) {
      console.log('ℹ️  No files configured for removal\n');
      return;
    }

    console.log(`🗑️  Removing ${CONFIG.filesToRemove.length} file(s)/directory(ies)...`);
    
    let removedCount = 0;
    let notFoundCount = 0;

    for (const filePattern of CONFIG.filesToRemove) {
      const fullPath = path.join(this.extractDir, filePattern);
      
      try {
        // Check if path exists
        await fsPromises.access(fullPath);
        
        // Remove file or directory
        const stats = await fsPromises.stat(fullPath);
        if (stats.isDirectory()) {
          await fsPromises.rm(fullPath, { recursive: true, force: true });
          console.log(`  ✅ Removed directory: ${filePattern}`);
        } else {
          await fsPromises.unlink(fullPath);
          console.log(`  ✅ Removed file: ${filePattern}`);
        }
        removedCount++;
        
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`  ⏭️  Not found (skipping): ${filePattern}`);
          notFoundCount++;
        } else {
          throw new Error(`Failed to remove ${filePattern}: ${error.message}`);
        }
      }
    }
    
    console.log(`\n📊 Removal summary: ${removedCount} removed, ${notFoundCount} not found\n`);
  }

  async pruneDemoDirectories() {
    console.log('🧹 Pruning demo directories while preserving demo/resources...');

    for (const relativePath of CONFIG.demoDirectories) {
      const demoDir = path.join(this.extractDir, relativePath);
      let entries;
      try {
        entries = await fsPromises.readdir(demoDir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`  ⏭️  Not found (skipping): ${relativePath}`);
          continue;
        }
        throw new Error(`Failed to read ${relativePath}: ${error.message}`);
      }

      for (const entry of entries) {
        if (entry.name === 'resources' && entry.isDirectory()) continue;
        await fsPromises.rm(path.join(demoDir, entry.name), { recursive: true, force: true });
      }
      console.log(`  ✅ Preserved: ${relativePath}/resources`);
    }

    console.log('');
  }

  async addOrReplaceFiles() {
    const entries = Object.entries(CONFIG.filesToAddOrReplace);
    
    if (entries.length === 0) {
      console.log('ℹ️  No files configured to add or replace\n');
      return;
    }

    console.log(`📝 Adding/replacing ${entries.length} file(s)...`);
    
    let addedCount = 0;
    let replacedCount = 0;

    for (const [destPath, config] of entries) {
      const fullDestPath = path.join(this.extractDir, destPath);
      
      try {
        // Check if file already exists
        const exists = fs.existsSync(fullDestPath);
        
        // Ensure destination directory exists
        await fsPromises.mkdir(path.dirname(fullDestPath), { recursive: true });
        
        // Get content based on type
        let content;
        if (config.type === 'file') {
          // Copy from source file
          content = await fsPromises.readFile(config.source);
          await fsPromises.writeFile(fullDestPath, content);
        } else if (config.type === 'content') {
          // Use provided content
          await fsPromises.writeFile(fullDestPath, config.content, 'utf-8');
        } else {
          throw new Error(`Unknown replacement type for ${destPath}: ${config.type}`);
        }
        
        if (exists) {
          console.log(`  ✅ Replaced: ${destPath}`);
          replacedCount++;
        } else {
          console.log(`  ✅ Added: ${destPath}`);
          addedCount++;
        }
        
      } catch (error) {
        throw new Error(`Failed to process ${destPath}: ${error.message}`);
      }
    }
    
    console.log(`\n📊 File operations summary: ${addedCount} added, ${replacedCount} replaced\n`);
  }

  async applyTextReplacements() {
    const entries = Object.entries(CONFIG.textReplacements);
    
    if (entries.length === 0) {
      console.log('ℹ️  No text replacements configured\n');
      return;
    }

    console.log(`✏️  Applying text replacements to ${entries.length} file(s)...`);
    
    let modifiedCount = 0;

    for (const [filePath, replacements] of entries) {
      const fullPath = path.join(this.extractDir, filePath);
      
      try {
        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Text replacement target not found: ${filePath}`);
        }
        
        // Read file content
        let content = await fsPromises.readFile(fullPath, 'utf-8');
        let modified = false;
        
        // Apply each replacement
        for (const replacement of replacements) {
          const { find, replace } = replacement;
          
          // Support both string and regex
          if (content.includes(find)) {
            content = content.split(find).join(replace);
            modified = true;
          }
        }
        
        if (modified) {
          await fsPromises.writeFile(fullPath, content, 'utf-8');
          console.log(`  ✅ Modified: ${filePath} (${replacements.length} replacement(s))`);
          modifiedCount++;
        } else {
          console.log(`  ℹ️  No changes needed: ${filePath}`);
        }
        
      } catch (error) {
        throw new Error(`Failed to modify ${filePath}: ${error.message}`);
      }
    }
    
    console.log(`\n📊 Text replacements summary: ${modifiedCount} file(s) modified\n`);
  }

  async validatePreparedRelease() {
    const removalFailures = CONFIG.filesToRemove.filter(
      relativePath => fs.existsSync(path.join(this.extractDir, relativePath))
    );
    if (removalFailures.length > 0) {
      throw new Error(`Release still contains paths configured for removal:\n- ${removalFailures.join('\n- ')}`);
    }

    for (const relativePath of CONFIG.demoDirectories) {
      const demoDir = path.join(this.extractDir, relativePath);
      let entries;
      try {
        entries = await fsPromises.readdir(demoDir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }

      const unexpectedEntries = entries.filter(
        entry => entry.name !== 'resources' || !entry.isDirectory()
      );
      if (unexpectedEntries.length > 0) {
        throw new Error(
          `Release contains unexpected demo content in ${relativePath}:\n- ${unexpectedEntries.map(entry => entry.name).join('\n- ')}`
        );
      }
    }

    for (const [destPath, config] of Object.entries(CONFIG.filesToAddOrReplace)) {
      const actual = await fsPromises.readFile(path.join(this.extractDir, destPath));
      const expected = config.type === 'file'
        ? await fsPromises.readFile(config.source)
        : Buffer.from(config.content, 'utf8');

      if (!actual.equals(expected)) {
        throw new Error(`Replacement verification failed: ${destPath}`);
      }
    }

    const unsafeFiles = [];
    await this.walkEntries(this.extractDir, async (relativePath, entry) => {
      if (
        entry.name === 'ca.key' ||
        entry.name === '.DS_Store' ||
        entry.name.startsWith('._')
      ) {
        unsafeFiles.push(relativePath);
      }
    });

    if (unsafeFiles.length > 0) {
      throw new Error(`Release contains excluded or sensitive files:\n- ${unsafeFiles.join('\n- ')}`);
    }

    console.log('✅ Prepared release contents validated\n');
  }

  async walkEntries(rootDir, callback, relativeDir = '') {
    const entries = await fsPromises.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      await callback(relativePath, entry);
      if (entry.isDirectory()) {
        await this.walkEntries(rootDir, callback, relativePath);
      }
    }
  }

  async getArchiveEntries() {
    const archiveEntries = [];
    await this.walkEntries(this.extractDir, async relativePath => {
      archiveEntries.push(relativePath.split(path.sep).join('/'));
    });
    return archiveEntries;
  }

  async createTarball() {
    console.log('📦 Creating new release tarball...');
    
    // Remove output file if it exists
    if (fs.existsSync(CONFIG.outputTarball)) {
      await fsPromises.unlink(CONFIG.outputTarball);
    }
    
    const files = await this.getArchiveEntries();
    const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH || '0');
    if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
      throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
    }
    
    await tar.create(
      {
        gzip: { level: 9 },
        file: CONFIG.outputTarball,
        cwd: this.extractDir,
        portable: true,
        mtime: new Date(sourceDateEpoch * 1000),
        noDirRecurse: true,
        // Exclude macOS AppleDouble resource fork files (._*)
        filter: (p) => !p.replace(/^\.[\\/]/, '').split(/[\\/]/).filter(Boolean).some(part => part.startsWith('._'))
      },
      files
    );
    
    // Get file size
    const stats = await fsPromises.stat(CONFIG.outputTarball);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`✅ Created: ${CONFIG.outputTarball} (${sizeMB} MB)\n`);
  }

  async createChecksum() {
    const archive = await fsPromises.readFile(CONFIG.outputTarball);
    const checksum = crypto.createHash('sha256').update(archive).digest('hex');
    await fsPromises.writeFile(
      `${CONFIG.outputTarball}.sha256`,
      `${checksum}  ${path.basename(CONFIG.outputTarball)}\n`,
      'utf8'
    );
  }

  async cleanup() {
    console.log('🧹 Cleaning up temporary files...');
    
    try {
      await fsPromises.rm(CONFIG.workingDir, { recursive: true, force: true });
      console.log('✅ Cleanup complete');
    } catch (error) {
      console.warn(`⚠️  Cleanup warning: ${error.message}`);
    }
  }
}

// ============================================================================
// CLI Execution
// ============================================================================

if (require.main === module) {
  const preparer = new ReleasePreparer();
  preparer.run().catch(error => {
    console.error('💥 Preparation failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = ReleasePreparer;
