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
  requiredBranches: ['main', 'feature-add-tos-download', 'feature-add-cart-page']
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
    
    // Clone and push repository content using git commands
    await this.cloneRepositoryWithGit(newRepoName, response.data.clone_url);
    
    return response.data;
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
      process.chdir('/Users/cheeragpatel/Documents/git/demo-setup-scripts');
      
      console.log(`✅ Successfully cloned repository content`);
      
    } catch (error) {
      // Make sure we're back in the original directory even if there's an error
      try {
        process.chdir('/Users/cheeragpatel/Documents/git/demo-setup-scripts');
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