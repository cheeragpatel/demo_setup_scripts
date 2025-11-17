#!/usr/bin/env node

require('dotenv').config();

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const fsPromises = require('fs').promises;
const csv = require('csv-parser');
const path = require('path');
const tar = require('tar');

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
    
    return metadata;
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
        contentType: 'demo-contents' // Track which type this came from
      };
    }
    
    // Add static-contents repositories
    for (const [repoName, repoConfig] of Object.entries(staticContents)) {
      repos[repoName] = {
        mainBranch: repoConfig.mainBranch,
        additionalBranches: repoConfig.additionalBranches || [],
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
    const response = await octokit.rest.repos.createInOrg({
      org: CONFIG.targetOrg,
      name: newRepoName,
      description: `Demo repository based on ${sourceRepoName}`,
      visibility: 'internal',
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      auto_init: false
    });

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
      // Copy extracted content to temp directory
      await fsPromises.mkdir(tempDir, { recursive: true });
      await this.copyDirectory(sourcePath, tempDir);
      
      // Initialize git repository
      process.chdir(tempDir);
      await this.runGitCommand('git init');
      await this.runGitCommand('git config user.email "workshop@example.com"');
      await this.runGitCommand('git config user.name "Workshop Setup"');
      
      // Add all content and commit
      await this.runGitCommand('git add -A');
      await this.runGitCommand('git commit -m "Initial commit from release package"');
      
      // Get all branches from source
      const branchDirs = await fsPromises.readdir(sourcePath);
      
      // Process each branch
      for (const branch of branchDirs) {
        const branchPath = path.join(sourcePath, branch);
        const stat = await fsPromises.stat(branchPath);
        
        if (stat.isDirectory()) {
          console.log(`  📋 Processing branch: ${branch}`);
          
          // Create and checkout branch
          if (branch !== 'main') {
            await this.runGitCommand(`git checkout -b ${branch}`);
          }
          
          // Clear temp directory
          await this.runGitCommand('git rm -rf .');
          
          // Copy branch content
          await this.copyDirectory(branchPath, tempDir);
          
          // Commit branch content
          await this.runGitCommand('git add -A');
          await this.runGitCommand(`git commit -m "Content for ${branch} branch" --allow-empty`);
        }
      }
      
      // Push all branches
      const targetUrlWithAuth = targetCloneUrl.replace('https://', `https://${CONFIG.githubToken}@`);
      await this.runGitCommand(`git remote add origin ${targetUrlWithAuth}`);
      await this.runGitCommand('git push -u origin --all');
      
      // Return to original directory
      process.chdir(this.originalWorkingDir);
      
      console.log(`  ✅ Successfully populated repository from ${repoConfig.contentType}`);
      
    } catch (error) {
      // Return to original directory on error
      try {
        process.chdir(this.originalWorkingDir);
      } catch (chdirError) {
        console.warn('Failed to change back to original directory');
      }
      
      console.error(`  ❌ Failed to populate repository: ${error.message}`);
      throw error;
    } finally {
      // Clean up temp directory
      try {
        await this.runGitCommand(`rm -rf ${tempDir}`);
      } catch (cleanupError) {
        console.warn(`  ⚠️ Failed to clean up temporary directory: ${tempDir}`);
      }
    }
  }

  async copyDirectory(source, destination) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    await execAsync(`cp -R "${source}"/. "${destination}"`);
  }

  async cloneRepositoryWithGit(newRepoName, targetCloneUrl) {
    console.log(`🔄 Cloning repository content using git commands...`);
    
    const tempDir = `/tmp/workshop-clone-${Date.now()}`;
    const sourceUrl = `https://github.com/${CONFIG.sourceOrg}/${CONFIG.sourceRepo}.git`;
    
    try {
      // Clone the source repository (not mirror, just regular clone)
      console.log(`📥 Cloning source repository: ${CONFIG.sourceOrg}/${CONFIG.sourceRepo}`);
      await this.runGitCommand(`git clone ${sourceUrl} ${tempDir}`);
      
      // Change to the cloned directory
      process.chdir(tempDir);
      
      // Fetch all branches
      await this.runGitCommand('git fetch --all');
      
      // Set the new remote URL for pushing
      const targetUrlWithAuth = targetCloneUrl.replace('https://', `https://${CONFIG.githubToken}@`);
      await this.runGitCommand(`git remote add target ${targetUrlWithAuth}`);
      
      // Push only the required branches
      console.log(`📤 Pushing required branches: ${CONFIG.requiredBranches.join(', ')}`);
      
      for (const branch of CONFIG.requiredBranches) {
        try {
          // Check if branch exists locally or remotely
          let branchExists = false;
          try {
            await this.runGitCommand(`git show-ref --verify --quiet refs/heads/${branch}`);
            branchExists = true;
            console.log(`  📋 Branch ${branch} exists locally`);
          } catch {
            try {
              await this.runGitCommand(`git show-ref --verify --quiet refs/remotes/origin/${branch}`);
              console.log(`  📋 Branch ${branch} exists on remote, checking out locally`);
              await this.runGitCommand(`git checkout -b ${branch} origin/${branch}`);
              branchExists = true;
            } catch {
              console.log(`  ⚠️ Branch ${branch} not found in source repository`);
            }
          }
          
          if (branchExists) {
            console.log(`  📤 Pushing branch: ${branch}`);
            await this.runGitCommand(`git push target ${branch}:${branch}`);
          }
        } catch (error) {
          console.warn(`  ⚠️ Failed to push branch ${branch}: ${error.message}`);
        }
      }
      
      // Set main as default branch if it exists
      if (CONFIG.requiredBranches.includes('main')) {
        try {
          await this.runGitCommand('git checkout main');
          await this.runGitCommand('git push target HEAD:refs/heads/main');
        } catch (error) {
          console.warn(`  ⚠️ Could not set main as default: ${error.message}`);
        }
      }
      
      // Clean up - go back to original directory
      process.chdir(this.originalWorkingDir);
      
      console.log(`✅ Successfully cloned repository content`);
      
    } catch (error) {
      // Make sure we're back in the original directory even if there's an error
      try {
        process.chdir(this.originalWorkingDir);
      } catch (chdirError) {
        console.warn('Failed to change back to original directory');
      }
      
      console.error(`❌ Git operations failed: ${error.message}`);
      throw error;
    } finally {
      // Clean up temporary directory
      try {
        await this.runGitCommand(`rm -rf ${tempDir}`);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to clean up temporary directory: ${tempDir}`);
      }
    }
  }

  async runGitCommand(command) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    console.log(`  🔧 Running: ${command.replace(CONFIG.githubToken, '***')}`);
    
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr && !stderr.includes('warning:') && !stderr.includes('Cloning into')) {
        console.log(`  ℹ️ Git output: ${stderr}`);
      }
      return stdout;
    } catch (error) {
      console.error(`  ❌ Command failed: ${error.message}`);
      throw error;
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
      await this.runGitCommand(`rm -rf ${CONFIG.workingDir}`);

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