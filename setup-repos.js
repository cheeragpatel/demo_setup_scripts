#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
require('dotenv').config();

// Configuration - Update these variables as needed
const CONFIG = {
  sourceOrg: process.env.SOURCE_ORG || 'your-source-org',
  sourceRepo: process.env.SOURCE_REPO || 'demo-repo',
  targetOrg: process.env.TARGET_ORG || 'your-target-org',
  csvFile: process.env.CSV_FILE || 'attendees.csv',
  githubToken: process.env.GITHUB_TOKEN,
  requiredBranches: ['main', 'feature-add-tos-download', 'feature-add-cart-page'],
  enableCodespaces: process.env.ENABLE_CODESPACES_PREBUILDS === 'true' || true // Default to true
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
    // Use a persistent cache directory for the source repository
    this.sourceCacheDir = `/tmp/workshop-source-cache-${CONFIG.sourceOrg}-${CONFIG.sourceRepo}`;
  }

  async validateConfig() {
    console.log('🔍 Validating configuration...');
    
    if (!CONFIG.githubToken) {
      throw new Error('GITHUB_TOKEN is required. Please set it in your .env file or environment variables.');
    }

    if (!fs.existsSync(CONFIG.csvFile)) {
      throw new Error(`CSV file not found: ${CONFIG.csvFile}`);
    }

    // Validate source repository exists
    try {
      await octokit.rest.repos.get({
        owner: CONFIG.sourceOrg,
        repo: CONFIG.sourceRepo
      });
      console.log('✅ Source repository validated');
    } catch (error) {
      throw new Error(`Source repository ${CONFIG.sourceOrg}/${CONFIG.sourceRepo} not found or not accessible`);
    }

    // Validate target organization exists
    try {
      await octokit.rest.orgs.get({
        org: CONFIG.targetOrg
      });
      console.log('✅ Target organization validated');
    } catch (error) {
      throw new Error(`Target organization ${CONFIG.targetOrg} not found or not accessible`);
    }
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

  async initializeSourceCache() {
    console.log(`🗂️ Initializing source repository cache...`);
    
    const sourceUrl = `https://github.com/${CONFIG.sourceOrg}/${CONFIG.sourceRepo}.git`;
    const fs = require('fs');
    
    // Check if cache directory exists
    if (fs.existsSync(this.sourceCacheDir)) {
      console.log(`  ✅ Found existing cache at ${this.sourceCacheDir}`);
      console.log(`  🔄 Updating cached repository...`);
      
      try {
        // Change to cache directory and fetch updates
        process.chdir(this.sourceCacheDir);
        await this.runGitCommand('git fetch --all --prune');
        console.log(`  ✅ Cache updated successfully`);
      } catch (error) {
        console.warn(`  ⚠️ Failed to update cache, will re-clone: ${error.message}`);
        // If update fails, remove the cache and re-clone
        process.chdir(this.originalWorkingDir);
        await this.runGitCommand(`rm -rf ${this.sourceCacheDir}`);
        await this.cloneSourceRepository(sourceUrl);
      } finally {
        process.chdir(this.originalWorkingDir);
      }
    } else {
      // Clone for the first time
      await this.cloneSourceRepository(sourceUrl);
    }
  }

  async cloneSourceRepository(sourceUrl) {
    console.log(`  📥 Cloning source repository: ${CONFIG.sourceOrg}/${CONFIG.sourceRepo}`);
    await this.runGitCommand(`git clone ${sourceUrl} ${this.sourceCacheDir}`);
    console.log(`  ✅ Source repository cached at ${this.sourceCacheDir}`);
  }

  async createDuplicateRepository(newRepoName) {
    console.log(`📦 Creating duplicate repository ${CONFIG.targetOrg}/${newRepoName}...`);
    
    // Get source repository details
    const sourceRepo = await octokit.rest.repos.get({
      owner: CONFIG.sourceOrg,
      repo: CONFIG.sourceRepo
    });

    // Create new empty repository with internal visibility
    const response = await octokit.rest.repos.createInOrg({
      org: CONFIG.targetOrg,
      name: newRepoName,
      description: `Workshop copy of ${sourceRepo.data.description || CONFIG.sourceRepo}`,
      visibility: 'internal', // Set to internal visibility
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      auto_init: false // Important: don't initialize with README
    });

    console.log(`✅ Created empty repository: ${CONFIG.targetOrg}/${newRepoName}`);
    
    // Push repository content from cached source using git commands
    await this.pushFromCachedSource(newRepoName, response.data.clone_url);
    
    return response.data;
  }

  async pushFromCachedSource(newRepoName, targetCloneUrl) {
    console.log(`🔄 Pushing repository content from cache...`);
    
    try {
      // Change to the cached source directory
      process.chdir(this.sourceCacheDir);
      
      // Set the new remote URL for pushing
      const targetUrlWithAuth = targetCloneUrl.replace('https://', `https://${CONFIG.githubToken}@`);
      
      // Remove target remote if it exists from previous runs
      try {
        await this.runGitCommand('git remote remove target');
      } catch (error) {
        // Ignore error if remote doesn't exist
      }
      
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
      
      // Clean up target remote
      try {
        await this.runGitCommand('git remote remove target');
      } catch (error) {
        // Ignore error
      }
      
      // Go back to original directory
      process.chdir(this.originalWorkingDir);
      
      console.log(`✅ Successfully pushed repository content from cache`);
      
    } catch (error) {
      // Make sure we're back in the original directory even if there's an error
      try {
        process.chdir(this.originalWorkingDir);
      } catch (chdirError) {
        console.warn('Failed to change back to original directory');
      }
      
      console.error(`❌ Git operations failed: ${error.message}`);
      throw error;
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

  async ensureRequiredBranchesExist(repoName) {
    console.log(`🌿 Verifying required branches exist in ${repoName}...`);
    
    try {
      // Get all branches from the target repository
      const branches = await octokit.rest.repos.listBranches({
        owner: CONFIG.targetOrg,
        repo: repoName,
        per_page: 100
      });
      
      const existingBranches = branches.data.map(b => b.name);
      const missingBranches = CONFIG.requiredBranches.filter(b => !existingBranches.includes(b));
      
      if (missingBranches.length === 0) {
        console.log(`  ✅ All required branches exist: ${CONFIG.requiredBranches.join(', ')}`);
        return;
      }
      
      console.log(`  🔧 Creating missing branches: ${missingBranches.join(', ')}`);
      
      // Get main branch (or first available branch) to create missing branches from
      const baseBranch = existingBranches.includes('main') 
        ? branches.data.find(b => b.name === 'main')
        : branches.data[0];
      
      if (!baseBranch) {
        console.log(`  ⚠️ No base branch found to create missing branches from`);
        return;
      }
      
      // Create missing branches
      for (const branch of missingBranches) {
        try {
          await octokit.rest.git.createRef({
            owner: CONFIG.targetOrg,
            repo: repoName,
            ref: `refs/heads/${branch}`,
            sha: baseBranch.commit.sha
          });
          console.log(`    ✅ Created branch: ${branch}`);
        } catch (error) {
          console.log(`    ⚠️ Failed to create branch ${branch}: ${error.message}`);
        }
      }
      
    } catch (error) {
      console.error(`❌ Failed to verify branches: ${error.message}`);
      // Don't throw here - this is not critical to the main functionality
    }
  }



  async createOrUpdateRef(owner, repo, branch, sha) {
    try {
      // Try to create new reference
      await octokit.rest.git.createRef({
        owner: owner,
        repo: repo,
        ref: `refs/heads/${branch}`,
        sha: sha
      });
    } catch (refError) {
      // If reference already exists, update it
      if (refError.status === 422 && refError.message.includes('already exists')) {
        await octokit.rest.git.updateRef({
          owner: owner,
          repo: repo,
          ref: `heads/${branch}`,
          sha: sha
        });
      } else {
        throw refError;
      }
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
    console.log(`👤 Adding ${username} as owner of ${repoName}...`);
    
    try {
      await octokit.rest.repos.addCollaborator({
        owner: CONFIG.targetOrg,
        repo: repoName,
        username: username,
        permission: 'admin'
      });
      console.log(`✅ Added ${username} as admin collaborator`);
    } catch (error) {
      if (error.status === 422) {
        console.log(`ℹ️ ${username} is already a collaborator`);
      } else {
        throw error;
      }
    }
  }

  async setupRepoForAttendee(attendee) {
    const repoName = `${CONFIG.sourceRepo}-${attendee.githubUsername}`;
    
    console.log(`\n🚀 Setting up repository for ${attendee.githubUsername}...`);
    
    try {
      // Check if repo already exists
      if (await this.checkRepoExists(repoName)) {
        console.log(`⏭️ Repository ${repoName} already exists, skipping...`);
        this.results.skipped.push({
          attendee,
          repoName,
          reason: 'Repository already exists'
        });
        return;
      }

      // Create duplicate repository
      await this.createDuplicateRepository(repoName);

      // Ensure any missing required branches are created
      await this.ensureRequiredBranchesExist(repoName);

      // Add attendee as collaborator
      await this.addCollaborator(repoName, attendee.githubUsername);

      // Prebuild Codespaces for the repository
      await this.prebuildCodespaces(repoName);

      console.log(`✅ Successfully set up repository: ${CONFIG.targetOrg}/${repoName}`);
      this.results.success.push({
        attendee,
        repoName,
        repoUrl: `https://github.com/${CONFIG.targetOrg}/${repoName}`
      });

    } catch (error) {
      console.error(`❌ Failed to set up repository for ${attendee.githubUsername}: ${error.message}`);
      this.results.failed.push({
        attendee,
        repoName,
        error: error.message
      });
    }
  }

  async run() {
    console.log('🎯 Workshop Repository Setup Starting...\n');
    
    try {
      // Validate configuration
      await this.validateConfig();

      // Load attendees
      const attendees = await this.loadAttendees();

      if (attendees.length === 0) {
        console.log('⚠️ No attendees found in CSV file');
        return;
      }

      // Initialize the source repository cache (clone once, reuse for all attendees)
      await this.initializeSourceCache();

      // Process each attendee
      for (let i = 0; i < attendees.length; i++) {
        const attendee = attendees[i];
        console.log(`\n📊 Progress: ${i + 1}/${attendees.length}`);
        
        await this.setupRepoForAttendee(attendee);
        
        // Add a small delay to avoid rate limiting
        if (i < attendees.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Print summary
      this.printSummary();

    } catch (error) {
      console.error('💥 Setup failed:', error.message);
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
        console.log(`  • ${result.repoName} for ${result.attendee.githubUsername}`);
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