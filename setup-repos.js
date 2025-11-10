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

  async forkRepository(newRepoName) {
    console.log(`🍴 Forking repository to ${CONFIG.targetOrg}/${newRepoName}...`);
    
    const response = await octokit.rest.repos.createFork({
      owner: CONFIG.sourceOrg,
      repo: CONFIG.sourceRepo,
      organization: CONFIG.targetOrg,
      name: newRepoName
    });

    // Wait for fork to be ready
    await this.waitForRepo(newRepoName);
    
    return response.data;
  }

  async waitForRepo(repoName, maxAttempts = 30) {
    console.log(`⏳ Waiting for repository ${repoName} to be ready...`);
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const repo = await octokit.rest.repos.get({
          owner: CONFIG.targetOrg,
          repo: repoName
        });
        
        if (!repo.data.fork || repo.data.size > 0) {
          console.log('✅ Repository is ready');
          return repo.data;
        }
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    }
    
    throw new Error(`Repository ${repoName} not ready after ${maxAttempts} attempts`);
  }

  async createRequiredBranches(repoName) {
    console.log(`🌿 Creating required branches for ${repoName}...`);
    
    // Get the main branch SHA
    const mainBranch = await octokit.rest.repos.getBranch({
      owner: CONFIG.targetOrg,
      repo: repoName,
      branch: 'main'
    });
    
    const mainSha = mainBranch.data.commit.sha;
    
    // Create each required branch (skip main as it already exists)
    for (const branch of CONFIG.requiredBranches) {
      if (branch === 'main') continue;
      
      try {
        // Check if branch exists in source repo
        const sourceBranch = await octokit.rest.repos.getBranch({
          owner: CONFIG.sourceOrg,
          repo: CONFIG.sourceRepo,
          branch: branch
        });
        
        // Create branch in target repo using the SHA from source
        await octokit.rest.git.createRef({
          owner: CONFIG.targetOrg,
          repo: repoName,
          ref: `refs/heads/${branch}`,
          sha: sourceBranch.data.commit.sha
        });
        
        console.log(`  ✅ Created branch: ${branch}`);
      } catch (error) {
        if (error.status === 422 && error.message.includes('already exists')) {
          console.log(`  ℹ️ Branch ${branch} already exists`);
        } else if (error.status === 404) {
          console.log(`  ⚠️ Branch ${branch} not found in source repo, creating from main`);
          await octokit.rest.git.createRef({
            owner: CONFIG.targetOrg,
            repo: repoName,
            ref: `refs/heads/${branch}`,
            sha: mainSha
          });
        } else {
          throw error;
        }
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

      // Fork the repository
      await this.forkRepository(repoName);

      // Create required branches
      await this.createRequiredBranches(repoName);

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

// Run the script
if (require.main === module) {
  const setup = new WorkshopRepoSetup();
  setup.run().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = WorkshopRepoSetup;