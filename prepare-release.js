#!/usr/bin/env node
// Usage: node prepare-release.js


require('dotenv').config();

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const tar = require('tar');

// ============================================================================
// CONFIGURATION - Update these variables for your customizations
// ============================================================================

const CONFIG = {
  // Input and output files
  inputTarball: process.env.INPUT_RELEASE_TARBALL || './release.tar.gz',
  outputTarball: process.env.OUTPUT_RELEASE_TARBALL || './workshop-release.tar.gz',
  
  // Working directory for extraction/repackaging
  workingDir: './temp-prepare-release',
  
  // Files/directories to remove (relative to extracted root)
  filesToRemove: [
    // Remove all contents from demo directories
    'demo-contents/octocatSupply/nodejs/demo',
    'demo-contents/octocatSupply/nodejs-feature-add-cart-page/demo',
    'demo-contents/octocatSupply/nodejs-feature-add-tos-download/demo',
    'demo-contents/octocatSupply/nodejs/CONTRIBUTING.md',
    'demo-contents/octocatSupply/nodejs-feature-add-tos-download/CONTRIBUTING.md',
    'demo-contents/octocatSupply/nodejs-feature-add-cart-page/CONTRIBUTING.md',
    // Example: Remove .octodemo directory from all repos
    // 'demo-contents/octocatSupply/nodejs/.octodemo',
    // 'demo-contents/octocatSupply/nodejs-feature-add-cart-page/.octodemo',
    // 'demo-contents/octocatSupply/nodejs-feature-add-tos-download/.octodemo',
    
    // Example: Remove internal documentation
    // 'demo-contents/octocatSupply/nodejs/INTERNAL.md',
    
    // Example: Remove specific workflow files
    // 'demo-contents/octocatSupply/nodejs/.github/workflows/internal-only.yml',
  ],
  
  // Files to add or replace (key: destination path, value: source path or content)
  filesToAddOrReplace: {
    // Add a workshop-specific README
    'demo-contents/octocatSupply/nodejs/README.md': {
      type: 'file',
      source: './workshop-files/README.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-cart-page/README.md': {
      type: 'file',
      source: './workshop-files/README.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-tos-download/README.md': {
      type: 'file',
      source: './workshop-files/README.md'
    },
    'demo-contents/octocatSupply/nodejs/docs/workshop-agent-mode.md': {
      type: 'file',
      source: './workshop-files/workshop-agent-mode.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-cart-page/docs/workshop-agent-mode.md': {
      type: 'file',
      source: './workshop-files/workshop-agent-mode.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-tos-download/docs/workshop-agent-mode.md': {
      type: 'file',
      source: './workshop-files/workshop-agent-mode.md'
    },
    'demo-contents/octocatSupply/nodejs/docs/workshop-use-case-focused.md': {
      type: 'file',
      source: './workshop-files/workshop-use-case-focused.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-cart-page/docs/workshop-use-case-focused.md': {
      type: 'file',
      source: './workshop-files/workshop-use-case-focused.md'
    },
    'demo-contents/octocatSupply/nodejs-feature-add-tos-download/docs/workshop-use-case-focused.md': {
      type: 'file',
      source: './workshop-files/workshop-use-case-focused.md'
    },

    // Example: Add a workshop-specific README
    // 'demo-contents/octocatSupply/nodejs/WORKSHOP.md': {
    //   type: 'file',
    //   source: './workshop-files/WORKSHOP.md'
    // },
    
    // Example: Add content directly
    // 'demo-contents/octocatSupply/nodejs/GETTING-STARTED.md': {
    //   type: 'content',
    //   content: '# Getting Started\n\nWelcome to the workshop!'
    // },
    
    // Example: Replace an existing file
    // 'demo-contents/octocatSupply/nodejs/README.md': {
    //   type: 'file',
    //   source: './workshop-files/README.md'
    // }
  },
  
  // Text replacements to apply to specific files
  textReplacements: {
    // Example: Replace text in README files
    // 'demo-contents/octocatSupply/nodejs/README.md': [
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
      // Validate input file exists
      if (!fs.existsSync(CONFIG.inputTarball)) {
        throw new Error(`Input tarball not found: ${CONFIG.inputTarball}`);
      }
      console.log(`📦 Input: ${CONFIG.inputTarball}`);
      console.log(`📦 Output: ${CONFIG.outputTarball}\n`);

      // Step 1: Extract the original tarball
      await this.extractTarball();

      // Step 2: Remove unwanted files/directories
      await this.removeFiles();

      // Step 3: Add or replace files
      await this.addOrReplaceFiles();

      // Step 4: Apply text replacements
      await this.applyTextReplacements();

      // Step 5: Repackage as new tarball
      await this.createTarball();

      // Step 6: Cleanup
      await this.cleanup();

      console.log('\n✅ Release package preparation completed successfully!');
      console.log(`📦 Workshop release: ${CONFIG.outputTarball}`);

    } catch (error) {
      console.error('💥 Preparation failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
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
      cwd: this.extractDir
    });
    
    console.log('✅ Extracted successfully\n');
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
          console.error(`  ❌ Failed to remove ${filePattern}: ${error.message}`);
        }
      }
    }
    
    console.log(`\n📊 Removal summary: ${removedCount} removed, ${notFoundCount} not found\n`);
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
          if (!fs.existsSync(config.source)) {
            console.error(`  ❌ Source file not found: ${config.source}`);
            continue;
          }
          content = await fsPromises.readFile(config.source);
          await fsPromises.writeFile(fullDestPath, content);
        } else if (config.type === 'content') {
          // Use provided content
          await fsPromises.writeFile(fullDestPath, config.content, 'utf-8');
        } else {
          console.error(`  ❌ Unknown type for ${destPath}: ${config.type}`);
          continue;
        }
        
        if (exists) {
          console.log(`  ✅ Replaced: ${destPath}`);
          replacedCount++;
        } else {
          console.log(`  ✅ Added: ${destPath}`);
          addedCount++;
        }
        
      } catch (error) {
        console.error(`  ❌ Failed to process ${destPath}: ${error.message}`);
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
          console.log(`  ⏭️  File not found (skipping): ${filePath}`);
          continue;
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
        console.error(`  ❌ Failed to modify ${filePath}: ${error.message}`);
      }
    }
    
    console.log(`\n📊 Text replacements summary: ${modifiedCount} file(s) modified\n`);
  }

  async createTarball() {
    console.log('📦 Creating new release tarball...');
    
    // Remove output file if it exists
    if (fs.existsSync(CONFIG.outputTarball)) {
      await fsPromises.unlink(CONFIG.outputTarball);
    }
    
    // Get all files/directories in the extracted directory
    const files = await fsPromises.readdir(this.extractDir);
    
    await tar.create(
      {
        gzip: true,
        file: CONFIG.outputTarball,
        cwd: this.extractDir
      },
      files
    );
    
    // Get file size
    const stats = await fsPromises.stat(CONFIG.outputTarball);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`✅ Created: ${CONFIG.outputTarball} (${sizeMB} MB)\n`);
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
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = ReleasePreparer;
