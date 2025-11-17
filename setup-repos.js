#!/usr/bin/env node

require('dotenv').config();

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const fsPromises = require('fs').promises;
const csv = require('csv-parser');
const path = require('path');
const tar = require('tar');
const { Liquid } = require('liquidjs');

// Configuration - Update these variables as needed
const CONFIG = {
  releaseTarball: process.env.RELEASE_TARBALL || './release.tar.gz',
  targetOrg: process.env.TARGET_ORG || 'your-target-org',
  csvFile: process.env.CSV_FILE || 'attendees.csv',
  githubToken: process.env.GITHUB_TOKEN,
  workingDir: process.env.WORKING_DIR || './temp-release-setup',
  enableCodespaces: process.env.ENABLE_CODESPACES_PREBUILDS === 'true' || true, // Default to true
  
  // Performance & Rate Limiting
  concurrentAttendees: parseInt(process.env.CONCURRENT_ATTENDEES || '3'), // Process N attendees at once
  concurrentRepos: parseInt(process.env.CONCURRENT_REPOS || '2'), // Process N repos per attendee at once
  delayBetweenBatches: parseInt(process.env.DELAY_BETWEEN_BATCHES || '2000'), // ms delay between batches
  rateLimitBuffer: parseInt(process.env.RATE_LIMIT_BUFFER || '100'), // Keep this many API calls in reserve
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3'), // Number of retries for failed operations
  retryDelay: parseInt(process.env.RETRY_DELAY || '5000') // ms delay between retries
};

// Initialize Octokit
const octokit = new Octokit({
  auth: CONFIG.githubToken,
});

class WorkshopRepoSetup {
  constructor() {
    this.results = {
      success: [],
      skipped: [],
      failed: []
    };
    // Store the original working directory to return to later
    this.originalWorkingDir = process.cwd();
    
    // Rate limit tracking
    this.apiCallCount = 0;
    this.lastRateLimitCheck = Date.now();
    this.rateLimitInfo = {
      limit: 5000,
      remaining: 5000,
      reset: Date.now() + 3600000
    };
  }

  async checkRateLimit() {
    try {
      const { data } = await octokit.rest.rateLimit.get();
      this.rateLimitInfo = {
        limit: data.rate.limit,
        remaining: data.rate.remaining,
        reset: data.rate.reset * 1000
      };
      
      const remainingCalls = this.rateLimitInfo.remaining;
      const resetTime = new Date(this.rateLimitInfo.reset);
      
      console.log(`ℹ️  Rate Limit: ${remainingCalls}/${this.rateLimitInfo.limit} remaining (resets at ${resetTime.toLocaleTimeString()})`);
      
      // If we're running low on API calls, wait until reset
      if (remainingCalls < CONFIG.rateLimitBuffer) {
        const waitTime = this.rateLimitInfo.reset - Date.now();
        if (waitTime > 0) {
          console.log(`⏰ Rate limit low (${remainingCalls} remaining). Waiting ${Math.ceil(waitTime / 1000)}s until reset...`);
          await this.sleep(waitTime + 1000); // Add 1s buffer
          console.log('✅ Rate limit reset, continuing...');
        }
      }
      
      return remainingCalls;
    } catch (error) {
      console.warn(`⚠️  Could not check rate limit: ${error.message}`);
      return 5000; // Assume we have calls available
    }
  }
  
  async waitIfNeeded() {
    // Check rate limit every 10 API calls or every 5 minutes
    const timeSinceLastCheck = Date.now() - this.lastRateLimitCheck;
    if (this.apiCallCount >= 10 || timeSinceLastCheck > 300000) {
      await this.checkRateLimit();
      this.apiCallCount = 0;
      this.lastRateLimitCheck = Date.now();
    }
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async retryOperation(operation, operationName, maxRetries = CONFIG.retryAttempts) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        // Check if it's a rate limit error
        if (error.status === 403 && error.message.includes('rate limit')) {
          console.log(`⏰ Rate limit hit during ${operationName}. Checking limits...`);
          await this.checkRateLimit();
          continue;
        }
        
        // Check if it's a secondary rate limit (abuse detection)
        if (error.status === 403 && error.message.includes('abuse')) {
          const waitTime = Math.min(60000 * attempt, 300000); // Up to 5 minutes
          console.log(`⏰ Secondary rate limit hit. Waiting ${waitTime / 1000}s before retry ${attempt}/${maxRetries}...`);
          await this.sleep(waitTime);
          continue;
        }
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        console.log(`⚠️  Attempt ${attempt}/${maxRetries} failed for ${operationName}: ${error.message}`);
        await this.sleep(CONFIG.retryDelay * attempt); // Exponential backoff
      }
    }
  }

  async validateConfig() {
    console.log('🔍 Validating configuration...');
    
    if (!CONFIG.githubToken) {
      throw new Error('GITHUB_TOKEN is required. Please set it as an environment variable.');
    }

    if (!fs.existsSync(CONFIG.csvFile)) {
      throw new Error(`CSV file not found: ${CONFIG.csvFile}`);
    }

    // Validate release tarball exists
    if (!fs.existsSync(CONFIG.releaseTarball)) {
      throw new Error(`Release tarball not found: ${CONFIG.releaseTarball}`);
    }
    console.log('✅ Release tarball found');

    // Validate target organization exists
    try {
      this.apiCallCount++;
      await octokit.rest.orgs.get({
        org: CONFIG.targetOrg
      });
      console.log('✅ Target organization validated');
      
      // Check initial rate limit
      await this.checkRateLimit();
    } catch (error) {
      throw new Error(`Target organization ${CONFIG.targetOrg} not found or not accessible`);
    }
  }

  async extractRelease() {
    console.log('📦 Extracting release tarball...');
    
    const extractDir = path.join(CONFIG.workingDir, 'extracted');
    await fsPromises.mkdir(extractDir, { recursive: true });
    
    await tar.extract({
      file: CONFIG.releaseTarball,
      cwd: extractDir
    });
    
    console.log('✅ Release extracted');
    return extractDir;
  }

  async loadMetadata(extractDir) {
    console.log('📖 Loading demo metadata...');
    
    const metadataPath = path.join(extractDir, '.octodemo', 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error('metadata.json not found in release package');
    }
    
    const metadata = JSON.parse(await fsPromises.readFile(metadataPath, 'utf-8'));
    console.log(`✅ Loaded metadata for demo: ${metadata.name || 'unknown'}`);
    
    // Store metadata for template context
    this.metadata = metadata;
    
    return metadata;
  }

  buildTemplateContext(newRepoName, sourceRepoName, repoConfig) {
    // Build a template context similar to gh-octodemo's deployment context
    const context = {
      source: {
        version: this.metadata?.version || '1.0.0',
        url: this.metadata?.url || '',
        github_instance_url: 'https://github.com'
      },
      demo_instance_name: newRepoName,
      demo_slug: this.metadata?.shortname || sourceRepoName,
      demo_org: {
        owner: CONFIG.targetOrg,
        github_instance_url: 'https://github.com'
      },
      repository_name: newRepoName,
      source_repository: sourceRepoName
    };
    
    return context;
  }

  async loadIssueBlueprints(extractDir, sourceRepoName) {
    const issueContentPath = path.join(extractDir, '.octodemo', 'demo', 'issue-contents');
    
    // Check if issue content directory exists
    try {
      await fsPromises.access(issueContentPath);
    } catch (error) {
      console.log('  ℹ️  No issue blueprints found in release package');
      return [];
    }

    const issues = [];
    
    // Determine backend type from metadata
    const backend = this.metadata?.templateMainBranch || 'nodejs';
    
    try {
      // Load the main issues (these are hardcoded in the blueprint)
      const legalDownloadPath = path.join(issueContentPath, 'legal-download-issue.md');
      const unittestPath = path.join(issueContentPath, `unittest-issue-${backend}.md`);
      
      let legalDownloadBody = '';
      let unittestBody = '';
      
      try {
        legalDownloadBody = await fsPromises.readFile(legalDownloadPath, 'utf-8');
      } catch (error) {
        console.log('  ⚠️  legal-download-issue.md not found');
      }
      
      try {
        unittestBody = await fsPromises.readFile(unittestPath, 'utf-8');
      } catch (error) {
        console.log(`  ⚠️  unittest-issue-${backend}.md not found`);
      }

      // Define the issues based on issue-blueprints.js structure
      if (legalDownloadBody) {
        issues.push({
          title: 'Compliance Requirements',
          body: `## Overview\n\nAs an e-commerce platform, we need to implement essential compliance features to operate legally and maintain customer trust. This epic encompasses all regulatory and legal requirements necessary for our web shop operations.\n\n## Key Requirements\n\n- **Terms and Conditions**: Implement downloadable terms of service\n- **Privacy Policy**: Create and maintain privacy documentation\n- **Data Protection**: Ensure GDPR/CCPA compliance\n- **Legal Documentation**: Provide accessible legal documents\n- **Cookie Policies**: Implement proper consent mechanisms\n\n## Business Impact\n\nWithout proper compliance measures, we cannot:\n- Legally operate as a web shop\n- Process customer data safely\n- Build customer trust and credibility\n- Avoid regulatory penalties\n\n## Acceptance Criteria\n\n- [ ] All legal documents are accessible to customers\n- [ ] Terms and conditions can be downloaded\n- [ ] Privacy policies are clearly stated\n- [ ] Compliance with relevant data protection laws\n- [ ] Legal team approval on all documentation`,
          labels: []
        });
        
        issues.push({
          title: 'Allow downloading our terms and conditions',
          body: legalDownloadBody,
          labels: ['good first issue']
        });
        
        issues.push({
          title: 'Add terms acceptance to checkout process',
          body: `## Overview\n\nImplement terms and conditions acceptance as a required step in the checkout process. Customers must acknowledge and accept our terms before completing their purchase.\n\n## Requirements\n\n- Add a checkbox during checkout requiring users to accept terms and conditions\n- Include a link to download the full terms and conditions document\n- Prevent order completion until terms are accepted\n- Store acceptance timestamp and IP address for legal compliance\n\n## Dependencies\n\nThis feature is **blocked by** the "Allow downloading our terms and conditions" issue, as users need to be able to access and review the terms via a downloadable link before they can properly accept them.\n\n## Acceptance Criteria\n\n- [ ] Checkbox appears on checkout page with clear terms acceptance text\n- [ ] Download link for terms and conditions is prominently displayed\n- [ ] Checkout cannot proceed without terms acceptance\n- [ ] Acceptance is logged with timestamp and user information\n- [ ] Link opens terms document in new tab/window for easy review`,
          labels: []
        });
      }
      
      if (unittestBody) {
        issues.push({
          title: 'Improve test coverage for API',
          body: unittestBody,
          labels: ['testing']
        });
      }
      
    } catch (error) {
      console.warn(`  ⚠️  Error loading issue blueprints: ${error.message}`);
    }
    
    return issues;
  }

  async createIssues(repoName, issues) {
    if (!issues || issues.length === 0) {
      console.log('  ℹ️  No issues to create');
      return;
    }

    console.log(`  📝 Creating ${issues.length} issue(s) in ${repoName}...`);
    
    for (const issue of issues) {
      try {
        this.apiCallCount++;
        await this.waitIfNeeded();
        
        const issueData = {
          owner: CONFIG.targetOrg,
          repo: repoName,
          title: issue.title,
          body: issue.body
        };
        
        // Add labels if specified
        if (issue.labels && issue.labels.length > 0) {
          issueData.labels = issue.labels;
        }
        
        const response = await octokit.rest.issues.create(issueData);
        
        console.log(`    ✅ Created issue #${response.data.number}: ${issue.title}`);
        
        // Small delay between issue creations
        await this.sleep(500);
        
      } catch (error) {
        console.error(`    ❌ Failed to create issue "${issue.title}": ${error.message}`);
      }
    }
  }

  getRepositoriesFromMetadata(metadata) {
    const repos = {};
    
    // Process both demo-contents and static-contents
    const demoContents = metadata.demoContents || {};
    const staticContents = metadata.staticContents || {};
    
    // Add demo-contents repositories
    for (const [repoName, repoConfig] of Object.entries(demoContents)) {
      repos[repoName] = {
        mainBranch: repoConfig.mainBranch,
        additionalBranches: repoConfig.additionalBranches || [],
        templatedFiles: repoConfig.templatedFiles || [],
        contentType: 'demo-contents' // Track which type this came from
      };
    }
    
    // Add static-contents repositories
    for (const [repoName, repoConfig] of Object.entries(staticContents)) {
      repos[repoName] = {
        mainBranch: repoConfig.mainBranch,
        additionalBranches: repoConfig.additionalBranches || [],
        templatedFiles: repoConfig.templatedFiles || [],
        contentType: 'static-contents' // Track which type this came from
      };
    }
    
    const demoCount = Object.keys(demoContents).length;
    const staticCount = Object.keys(staticContents).length;
    
    console.log(`📋 Found ${Object.keys(repos).length} total repositories:`);
    if (demoCount > 0) console.log(`   - ${demoCount} demo-contents repositories`);
    if (staticCount > 0) console.log(`   - ${staticCount} static-contents repositories`);
    
    return repos;
  }

  async loadAttendees() {
    console.log(`📖 Loading attendees from ${CONFIG.csvFile}...`);
    
    const attendees = [];
    return new Promise((resolve, reject) => {
      fs.createReadStream(CONFIG.csvFile)
        .pipe(csv())
        .on('data', (row) => {
          // Expecting CSV with columns: github_username, email (optional)
          if (row.github_username) {
            attendees.push({
              githubUsername: row.github_username.trim(),
              email: row.email ? row.email.trim() : null
            });
          }
        })
        .on('end', () => {
          console.log(`✅ Loaded ${attendees.length} attendees`);
          resolve(attendees);
        })
        .on('error', reject);
    });
  }

  async checkRepoExists(repoName) {
    try {
      this.apiCallCount++;
      await octokit.rest.repos.get({
        owner: CONFIG.targetOrg,
        repo: repoName
      });
      return true;
    } catch (error) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async createRepositoryFromRelease(newRepoName, sourceRepoName, repoConfig, extractDir) {
    console.log(`  📦 Creating repository ${CONFIG.targetOrg}/${newRepoName}...`);
    
    // Create new empty repository with internal visibility
    this.apiCallCount++;
    let response;
    try {
      response = await octokit.rest.repos.createInOrg({
        org: CONFIG.targetOrg,
        name: newRepoName,
        description: `Demo repository based on ${sourceRepoName}`,
        visibility: 'internal',
        has_issues: true,
        has_projects: true,
        has_wiki: false,
        auto_init: false
      });
    } catch (error) {
      if (error.status === 422 && error.message.includes('name already exists')) {
        throw new Error(`Repository ${newRepoName} already exists (was not caught by pre-check)`);
      }
      throw new Error(`Repository creation failed.: ${error.message}`);
    }

    console.log(`  ✅ Created empty repository: ${CONFIG.targetOrg}/${newRepoName}`);
    
    // Populate repository with content from extracted release
    await this.populateRepositoryFromExtract(
      newRepoName, 
      sourceRepoName,
      repoConfig, 
      extractDir, 
      response.data.clone_url
    );
    
    return response.data;
  }

  async populateRepositoryFromExtract(newRepoName, sourceRepoName, repoConfig, extractDir, targetCloneUrl) {
    console.log(`  📂 Populating ${newRepoName} from extracted ${repoConfig.contentType}/${sourceRepoName}...`);
    
    // Use the contentType from repoConfig to find the correct source path
    const sourcePath = path.join(extractDir, repoConfig.contentType, sourceRepoName);
    
    // Check if source path exists
    try {
      await fsPromises.access(sourcePath);
    } catch (error) {
      throw new Error(`Source path not found: ${sourcePath}`);
    }
    
    const tempDir = `/tmp/workshop-populate-${Date.now()}`;
    
    try {
      // Initialize git repository first
      await fsPromises.mkdir(tempDir, { recursive: true });
      await this.runGitCommand('git init', tempDir);
      await this.runGitCommand('git config user.email "workshop@example.com"', tempDir);
      await this.runGitCommand('git config user.name "Workshop Setup"', tempDir);
      
      // Get all branch directories from source
      const branchDirs = await fsPromises.readdir(sourcePath);
      const branches = [];
      
      // Collect all directories that represent branches
      for (const item of branchDirs) {
        const itemPath = path.join(sourcePath, item);
        const stat = await fsPromises.stat(itemPath);
        if (stat.isDirectory()) {
          branches.push(item);
        }
      }
      
      if (branches.length === 0) {
        throw new Error(`No branch directories found in ${sourcePath}`);
      }
      
      console.log(`  📋 Found ${branches.length} branch(es): ${branches.join(', ')}`);
      
      // Determine main branch and process it first
      let mainBranchDir = branches.find(b => b === sourceRepoName || b === 'main');
      if (!mainBranchDir) {
        // If no obvious main branch, use the first one
        mainBranchDir = branches[0];
      }
      
      // Process main branch first
      console.log(`  📋 Processing main branch from directory: ${mainBranchDir}`);
      const mainBranchPath = path.join(sourcePath, mainBranchDir);
      await this.copyDirectory(mainBranchPath, tempDir);
      
      // Render templates for main branch
      if (repoConfig.templatedFiles && repoConfig.templatedFiles.length > 0) {
        const templateContext = this.buildTemplateContext(newRepoName, sourceRepoName, repoConfig);
        await this.renderTemplates(repoConfig.templatedFiles, tempDir, templateContext);
      }
      
      await this.runGitCommand('git add -A', tempDir);
      await this.runGitCommand('git commit -m "Initial commit from release package" --allow-empty', tempDir);
      
      // Process additional branches
      for (const branchDir of branches) {
        if (branchDir === mainBranchDir) continue; // Skip main branch
        
        // Determine the branch name - strip the main branch prefix if present
        let branchName = branchDir;
        if (branchDir.startsWith(mainBranchDir + '-')) {
          // e.g., "nodejs-feature-add-cart-page" -> "feature-add-cart-page"
          branchName = branchDir.substring(mainBranchDir.length + 1);
        }
        
        console.log(`  📋 Processing branch: ${branchName} (from directory: ${branchDir})`);
        const branchPath = path.join(sourcePath, branchDir);
        
        // Create and checkout new branch
        await this.runGitCommand(`git checkout -b ${branchName}`, tempDir);
        
        // Clear directory (keep .git)
        await this.runGitCommand('git rm -rf .', tempDir);
        
        // Copy branch content
        await this.copyDirectory(branchPath, tempDir);
        
        // Render templates for this branch
        if (repoConfig.templatedFiles && repoConfig.templatedFiles.length > 0) {
          const templateContext = this.buildTemplateContext(newRepoName, sourceRepoName, repoConfig);
          await this.renderTemplates(repoConfig.templatedFiles, tempDir, templateContext);
        }
        
        // Commit branch content
        await this.runGitCommand('git add -A', tempDir);
        await this.runGitCommand(`git commit -m "Content for ${branchName} branch" --allow-empty`, tempDir);
      }
      
      // Push all branches
      const targetUrlWithAuth = targetCloneUrl.replace('https://', `https://${CONFIG.githubToken}@`);
      await this.runGitCommand(`git remote add origin ${targetUrlWithAuth}`, tempDir);
      await this.runGitCommand('git push -u origin --all', tempDir);
      
      console.log(`  ✅ Successfully populated repository from ${repoConfig.contentType}`);
      
    } catch (error) {
      console.error(`  ❌ Failed to populate repository: ${error.message}`);
      throw error;
    } finally {
      // Clean up temp directory
      await this.safeCleanup(tempDir);
    }
  }

  async copyDirectory(source, destination) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    await execAsync(`cp -R "${source}"/. "${destination}"`);
  }

  async renderTemplates(templatedFiles, workingDir, context) {
    if (!templatedFiles || templatedFiles.length === 0) {
      return;
    }

    console.log(`  🎨 Rendering ${templatedFiles.length} template file(s)...`);
    
    // Initialize Liquid template engine with custom delimiters matching gh-octodemo
    const engine = new Liquid({
      tagDelimiterLeft: '<%',
      tagDelimiterRight: '%>',
      outputDelimiterLeft: '<$',
      outputDelimiterRight: '$>',
      greedy: false // Preserve whitespace
    });

    for (const templateFile of templatedFiles) {
      const filePath = path.join(workingDir, templateFile);
      
      try {
        // Check if file exists
        await fsPromises.access(filePath);
        
        // Read template file
        const templateContent = await fsPromises.readFile(filePath, 'utf-8');
        
        // Render template with context
        const rendered = await engine.parseAndRender(templateContent, context);
        
        // Write rendered content back to file
        await fsPromises.writeFile(filePath, rendered, 'utf-8');
        
        console.log(`    ✅ Rendered: ${templateFile}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`    ⚠️  Template file not found (skipping): ${templateFile}`);
        } else {
          console.error(`    ❌ Failed to render ${templateFile}: ${error.message}`);
          throw error;
        }
      }
    }
  }

  async cloneRepositoryWithGit(newRepoName, targetCloneUrl) {
    console.log(`🔄 Cloning repository content using git commands...`);
    
    const tempDir = `/tmp/workshop-clone-${Date.now()}`;
    const sourceUrl = `https://github.com/${CONFIG.sourceOrg}/${CONFIG.sourceRepo}.git`;
    
    try {
      // Clone the source repository (not mirror, just regular clone)
      console.log(`📥 Cloning source repository: ${CONFIG.sourceOrg}/${CONFIG.sourceRepo}`);
      await this.runGitCommand(`git clone ${sourceUrl} ${tempDir}`);
      
      // Fetch all branches
      await this.runGitCommand('git fetch --all', tempDir);
      
      // Set the new remote URL for pushing
      const targetUrlWithAuth = targetCloneUrl.replace('https://', `https://${CONFIG.githubToken}@`);
      await this.runGitCommand(`git remote add target ${targetUrlWithAuth}`, tempDir);
      
      // Push only the required branches
      console.log(`📤 Pushing required branches: ${CONFIG.requiredBranches.join(', ')}`);
      
      for (const branch of CONFIG.requiredBranches) {
        try {
          // Check if branch exists locally or remotely
          let branchExists = false;
          try {
            await this.runGitCommand(`git show-ref --verify --quiet refs/heads/${branch}`, tempDir);
            branchExists = true;
            console.log(`  📋 Branch ${branch} exists locally`);
          } catch {
            try {
              await this.runGitCommand(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, tempDir);
              console.log(`  📋 Branch ${branch} exists on remote, checking out locally`);
              await this.runGitCommand(`git checkout -b ${branch} origin/${branch}`, tempDir);
              branchExists = true;
            } catch {
              console.log(`  ⚠️ Branch ${branch} not found in source repository`);
            }
          }
          
          if (branchExists) {
            console.log(`  📤 Pushing branch: ${branch}`);
            await this.runGitCommand(`git push target ${branch}:${branch}`, tempDir);
          }
        } catch (error) {
          console.warn(`  ⚠️ Failed to push branch ${branch}: ${error.message}`);
        }
      }
      
      // Set main as default branch if it exists
      if (CONFIG.requiredBranches.includes('main')) {
        try {
          await this.runGitCommand('git checkout main', tempDir);
          await this.runGitCommand('git push target HEAD:refs/heads/main', tempDir);
        } catch (error) {
          console.warn(`  ⚠️ Could not set main as default: ${error.message}`);
        }
      }
      
      console.log(`✅ Successfully cloned repository content`);
      
    } catch (error) {
      console.error(`❌ Git operations failed: ${error.message}`);
      throw error;
    } finally {
      // Clean up temporary directory
      await this.safeCleanup(tempDir);
    }
  }

  async runGitCommand(command, cwd = null) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const displayCommand = command.replace(CONFIG.githubToken, '***');
    console.log(`  🔧 Running: ${displayCommand}${cwd ? ` (in ${cwd})` : ''}`);
    
    try {
      const options = cwd ? { cwd } : {};
      const { stdout, stderr } = await execAsync(command, options);
      if (stderr && !stderr.includes('warning:') && !stderr.includes('Cloning into')) {
        console.log(`  ℹ️ Git output: ${stderr}`);
      }
      return stdout;
    } catch (error) {
      console.error(`  ❌ Command failed: ${error.message}`);
      throw error;
    }
  }

  async safeCleanup(dirPath) {
    // Safety check: only allow cleanup of temp directories
    if (!dirPath.startsWith('/tmp/') && !dirPath.startsWith('./temp-')) {
      console.warn(`  ⚠️ Refusing to delete path outside of safe temp directories: ${dirPath}`);
      return;
    }
    
    try {
      await fsPromises.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`  ⚠️ Failed to clean up directory: ${dirPath} - ${error.message}`);
    }
  }

  async prebuildCodespaces(repoName) {
    console.log(`🚀 Setting up Codespaces prebuilds for ${repoName}...`);
    
    try {
      // Check if Codespaces API is available
      if (!octokit.rest.codespaces) {
        console.log(`  ℹ️ Codespaces API not available in current Octokit version`);
        console.log(`  💡 Codespaces can be manually enabled in repository settings`);
        return;
      }

      // First, check if the repository has a devcontainer configuration
      let hasDevcontainer = false;
      try {
        await octokit.rest.repos.getContent({
          owner: CONFIG.targetOrg,
          repo: repoName,
          path: '.devcontainer'
        });
        hasDevcontainer = true;
        console.log(`  ✅ Found .devcontainer configuration`);
      } catch (error) {
        if (error.status === 404) {
          // Check for devcontainer.json in root
          try {
            await octokit.rest.repos.getContent({
              owner: CONFIG.targetOrg,
              repo: repoName,
              path: '.devcontainer.json'
            });
            hasDevcontainer = true;
            console.log(`  ✅ Found .devcontainer.json in root`);
          } catch (rootError) {
            if (rootError.status === 404) {
              console.log(`  ℹ️ No devcontainer configuration found - Codespaces will use default environment`);
            } else {
              throw rootError;
            }
          }
        } else {
          throw error;
        }
      }

      // Enable repository features that support Codespaces
      try {
        console.log(`  🔧 Configuring repository settings for Codespaces...`);
        
        await octokit.rest.repos.update({
          owner: CONFIG.targetOrg,
          repo: repoName,
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          delete_branch_on_merge: true,
          has_issues: true,
          has_projects: true
        });
        
        console.log(`  ✅ Repository configured for Codespaces`);
      } catch (error) {
        console.log(`  ⚠️ Could not update repository settings: ${error.message}`);
      }

      // Try to use Codespaces API if available
      try {
        if (octokit.rest.codespaces && octokit.rest.codespaces.createRepoCodespacesPrebuild) {
          console.log(`  🏗️ Creating prebuild configuration for main branch...`);
          
          const prebuildConfig = await octokit.rest.codespaces.createRepoCodespacesPrebuild({
            owner: CONFIG.targetOrg,
            repo: repoName,
            ref: 'refs/heads/main'
          });
          
          console.log(`  ✅ Prebuild configuration created (ID: ${prebuildConfig.data.id})`);
          console.log(`  ℹ️ Prebuild will trigger on devcontainer configuration changes`);
        } else {
          throw new Error('Codespaces prebuild API not available');
        }
      } catch (apiError) {
        console.log(`  ℹ️ Codespaces prebuild API not available: ${apiError.message}`);
        console.log(`  💡 Manual setup: Go to repository Settings → Codespaces → Set up prebuilds`);
        
        if (hasDevcontainer) {
          console.log(`  🎯 Devcontainer detected - Codespaces will work with existing configuration`);
        } else {
          console.log(`  🔧 Consider adding a .devcontainer/devcontainer.json for custom environment`);
        }
      }

      console.log(`  ✅ Codespaces setup completed for ${repoName}`);
      
    } catch (error) {
      console.log(`  ⚠️ Codespaces setup encountered issues: ${error.message}`);
      console.log(`  💡 Repository is ready - Codespaces can be enabled manually if needed`);
      // Don't throw here - this is not critical to the main functionality
    }
  }




  async addCollaborator(repoName, username) {
    console.log(`  👤 Adding ${username} as owner of ${repoName}...`);
    
    try {
      this.apiCallCount++;
      await octokit.rest.repos.addCollaborator({
        owner: CONFIG.targetOrg,
        repo: repoName,
        username: username,
        permission: 'admin'
      });
      console.log(`  ✅ Added ${username} as admin collaborator`);
    } catch (error) {
      if (error.status === 422) {
        console.log(`  ℹ️ ${username} is already a collaborator`);
      } else {
        throw error;
      }
    }
  }

  async setupReposForAttendee(attendee, repositories, extractDir) {
    console.log(`\n🚀 Setting up repositories for ${attendee.githubUsername}...`);
    
    const repoEntries = Object.entries(repositories);
    const results = [];
    
    // Process repos in batches with concurrency control
    for (let i = 0; i < repoEntries.length; i += CONFIG.concurrentRepos) {
      const batch = repoEntries.slice(i, i + CONFIG.concurrentRepos);
      
      const batchPromises = batch.map(async ([sourceRepoName, repoConfig]) => {
        const newRepoName = `${sourceRepoName}-${attendee.githubUsername}`;
        
        try {
          // Check rate limit before processing
          await this.waitIfNeeded();
          
          // Check if repo already exists
          this.apiCallCount++;
          if (await this.checkRepoExists(newRepoName)) {
            console.log(`  ⏭️ Repository ${newRepoName} already exists, skipping...`);
            this.results.skipped.push({
              attendee,
              repoName: newRepoName,
              sourceRepo: sourceRepoName,
              reason: 'Repository already exists'
            });
            return { status: 'skipped', repoName: newRepoName };
          }

          // Create repository from release content (with retry)
          await this.retryOperation(
            () => this.createRepositoryFromRelease(newRepoName, sourceRepoName, repoConfig, extractDir),
            `create repository ${newRepoName}`
          );

          // Add attendee as collaborator (with retry)
          await this.retryOperation(
            () => this.addCollaborator(newRepoName, attendee.githubUsername),
            `add collaborator to ${newRepoName}`
          );

          // Create issues from blueprints (only for demo-contents repos)
          if (repoConfig.contentType === 'demo-contents') {
            try {
              const issues = await this.loadIssueBlueprints(extractDir, sourceRepoName);
              await this.createIssues(newRepoName, issues);
            } catch (error) {
              console.log(`  ℹ️  Issue creation skipped for ${newRepoName}: ${error.message}`);
            }
          }

          // Prebuild Codespaces for the repository (best effort, don't fail if this fails)
          try {
            await this.prebuildCodespaces(newRepoName);
          } catch (error) {
            console.log(`  ℹ️  Codespaces setup skipped for ${newRepoName}: ${error.message}`);
          }

          console.log(`  ✅ Successfully set up repository: ${CONFIG.targetOrg}/${newRepoName}`);
          this.results.success.push({
            attendee,
            repoName: newRepoName,
            sourceRepo: sourceRepoName,
            repoUrl: `https://github.com/${CONFIG.targetOrg}/${newRepoName}`
          });
          
          return { status: 'success', repoName: newRepoName };

        } catch (error) {
          console.error(`  ❌ Failed to set up repository ${newRepoName}: ${error.message}`);
          this.results.failed.push({
            attendee,
            repoName: newRepoName,
            sourceRepo: sourceRepoName,
            error: error.message
          });
          
          return { status: 'failed', repoName: newRepoName, error: error.message };
        }
      });
      
      results.push(...await Promise.all(batchPromises));
      
      // Small delay between batches to avoid abuse detection
      if (i + CONFIG.concurrentRepos < repoEntries.length) {
        await this.sleep(500);
      }
    }
    
    return results;
  }

  async run() {
    console.log('🎯 Workshop Repository Setup Starting (from release.tar.gz)...\n');
    
    try {
      // Validate configuration
      await this.validateConfig();
      
      // Extract release tarball
      const extractDir = await this.extractRelease();
      
      // Load metadata from release
      const metadata = await this.loadMetadata(extractDir);
      
      // Get repositories from metadata
      const repositories = this.getRepositoriesFromMetadata(metadata);
      
      if (Object.keys(repositories).length === 0) {
        console.log('⚠️ No repositories found in release package');
        return;
      }

      // Load attendees
      const attendees = await this.loadAttendees();

      if (attendees.length === 0) {
        console.log('⚠️ No attendees found in CSV file');
        return;
      }

      // Process attendees in batches for better performance
      console.log(`\n🚀 Processing ${attendees.length} attendees in batches of ${CONFIG.concurrentAttendees}...`);
      const startTime = Date.now();
      
      for (let i = 0; i < attendees.length; i += CONFIG.concurrentAttendees) {
        const batch = attendees.slice(i, i + CONFIG.concurrentAttendees);
        const batchNum = Math.floor(i / CONFIG.concurrentAttendees) + 1;
        const totalBatches = Math.ceil(attendees.length / CONFIG.concurrentAttendees);
        
        console.log(`\n📊 Batch ${batchNum}/${totalBatches} - Processing attendees ${i + 1}-${Math.min(i + CONFIG.concurrentAttendees, attendees.length)}/${attendees.length}`);
        
        // Check rate limit before each batch
        await this.waitIfNeeded();
        
        // Process batch concurrently
        const batchPromises = batch.map(attendee => 
          this.setupReposForAttendee(attendee, repositories, extractDir)
        );
        
        await Promise.all(batchPromises);
        
        // Calculate and display progress
        const processedCount = Math.min(i + CONFIG.concurrentAttendees, attendees.length);
        const percentComplete = Math.round((processedCount / attendees.length) * 100);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const avgTimePerAttendee = elapsed / processedCount;
        const remaining = Math.round((attendees.length - processedCount) * avgTimePerAttendee);
        
        console.log(`\n⏱️  Progress: ${percentComplete}% complete | Elapsed: ${elapsed}s | Est. remaining: ${remaining}s`);
        console.log(`   Success: ${this.results.success.length} | Skipped: ${this.results.skipped.length} | Failed: ${this.results.failed.length}`);
        
        // Delay between batches to avoid rate limiting
        if (i + CONFIG.concurrentAttendees < attendees.length) {
          console.log(`⏸️  Waiting ${CONFIG.delayBetweenBatches / 1000}s before next batch...`);
          await this.sleep(CONFIG.delayBetweenBatches);
        }
      }
      
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n✅ All attendees processed in ${totalTime}s (${Math.round(totalTime / 60)}m ${totalTime % 60}s)`);

      // Print summary
      this.printSummary();
      
      // Clean up extracted files
      console.log('\n🧹 Cleaning up...');
      await this.safeCleanup(CONFIG.workingDir);

    } catch (error) {
      console.error('💥 Setup failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 SETUP SUMMARY');
    console.log('='.repeat(50));
    
    console.log(`✅ Successful: ${this.results.success.length}`);
    console.log(`⏭️ Skipped: ${this.results.skipped.length}`);
    console.log(`❌ Failed: ${this.results.failed.length}`);

    if (this.results.success.length > 0) {
      console.log('\n✅ Successfully Created Repositories:');
      this.results.success.forEach(result => {
        console.log(`  • ${result.repoName} (from ${result.sourceRepo}) for ${result.attendee.githubUsername}`);
        console.log(`    📎 ${result.repoUrl}`);
      });
    }

    if (this.results.skipped.length > 0) {
      console.log('\n⏭️ Skipped Repositories:');
      this.results.skipped.forEach(result => {
        console.log(`  • ${result.repoName} - ${result.reason}`);
      });
    }

    if (this.results.failed.length > 0) {
      console.log('\n❌ Failed Repositories:');
      this.results.failed.forEach(result => {
        console.log(`  • ${result.repoName} for ${result.attendee.githubUsername}`);
        console.log(`    Error: ${result.error}`);
      });
    }

    // Write results to file
    const resultsFile = `setup-results-${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify(this.results, null, 2));
    console.log(`\n💾 Detailed results saved to: ${resultsFile}`);
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
const cleanup = args.includes('--cleanup') || args.includes('-c');

if (cleanup) {
  console.log('🧹 Cleanup mode detected - redirecting to cleanup script...\n');
  const WorkshopRepoCleanup = require('./cleanup-repos');
  const cleanupInstance = new WorkshopRepoCleanup();
  cleanupInstance.run().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
  return;
}

// Run the script
if (require.main === module) {
  const setup = new WorkshopRepoSetup();
  setup.run().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = WorkshopRepoSetup;