#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const csv = require('csv-parser');
const readline = require('readline');
require('dotenv').config();

// Configuration - Update these variables as needed
const CONFIG = {
  sourceOrg: process.env.SOURCE_ORG || 'your-source-org',
  sourceRepo: process.env.SOURCE_REPO || 'demo-repo',
  targetOrg: process.env.TARGET_ORG || 'your-target-org',
  csvFile: process.env.CSV_FILE || 'attendees.csv',
  githubToken: process.env.GITHUB_TOKEN,
};

// Initialize Octokit
const octokit = new Octokit({
  auth: CONFIG.githubToken,
});

class WorkshopRepoCleanup {
  constructor() {
    this.results = {
      deleted: [],
      notFound: [],
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

  async findExistingRepos(attendees) {
    console.log('🔍 Scanning for existing repositories...');
    
    const existingRepos = [];
    
    for (const attendee of attendees) {
      const repoName = `${CONFIG.sourceRepo}-${attendee.githubUsername}`;
      
      try {
        const repo = await octokit.rest.repos.get({
          owner: CONFIG.targetOrg,
          repo: repoName
        });
        
        existingRepos.push({
          attendee,
          repoName,
          repoUrl: repo.data.html_url,
          createdAt: repo.data.created_at,
          updatedAt: repo.data.updated_at
        });
      } catch (error) {
        if (error.status !== 404) {
          console.warn(`⚠️ Error checking ${repoName}: ${error.message}`);
        }
      }
    }
    
    console.log(`✅ Found ${existingRepos.length} existing repositories to potentially delete`);
    return existingRepos;
  }

  async confirmDeletion(repos) {
    if (repos.length === 0) {
      console.log('ℹ️ No repositories found to delete');
      return false;
    }

    console.log('\n' + '='.repeat(60));
    console.log('🗑️  REPOSITORIES TO BE DELETED');
    console.log('='.repeat(60));
    
    repos.forEach((repo, index) => {
      console.log(`${index + 1}. ${CONFIG.targetOrg}/${repo.repoName}`);
      console.log(`   Owner: ${repo.attendee.githubUsername}`);
      console.log(`   Created: ${new Date(repo.createdAt).toLocaleString()}`);
      console.log(`   URL: ${repo.repoUrl}`);
      console.log('');
    });

    console.log('⚠️  WARNING: This action CANNOT be undone!');
    console.log('⚠️  All repository data, issues, pull requests, and history will be permanently lost!');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('\n❓ Are you sure you want to delete these repositories? (type "DELETE" to confirm): ', resolve);
    });
    
    rl.close();
    
    return answer === 'DELETE';
  }

  async deleteRepository(repoInfo) {
    const { repoName, attendee } = repoInfo;
    
    console.log(`🗑️ Deleting repository: ${CONFIG.targetOrg}/${repoName}...`);
    
    try {
      await octokit.rest.repos.delete({
        owner: CONFIG.targetOrg,
        repo: repoName
      });
      
      console.log(`✅ Successfully deleted: ${CONFIG.targetOrg}/${repoName}`);
      this.results.deleted.push(repoInfo);
      
    } catch (error) {
      if (error.status === 404) {
        console.log(`ℹ️ Repository ${repoName} not found (may have been already deleted)`);
        this.results.notFound.push(repoInfo);
      } else {
        console.error(`❌ Failed to delete ${repoName}: ${error.message}`);
        this.results.failed.push({
          ...repoInfo,
          error: error.message
        });
      }
    }
  }

  async run() {
    console.log('🧹 Workshop Repository Cleanup Starting...\n');
    
    try {
      // Validate configuration
      await this.validateConfig();

      // Load attendees
      const attendees = await this.loadAttendees();

      if (attendees.length === 0) {
        console.log('⚠️ No attendees found in CSV file');
        return;
      }

      // Find existing repositories
      const existingRepos = await this.findExistingRepos(attendees);

      // Confirm deletion
      const confirmed = await this.confirmDeletion(existingRepos);
      
      if (!confirmed) {
        console.log('❌ Cleanup cancelled by user');
        return;
      }

      console.log('\n🚀 Starting repository deletion...\n');

      // Delete each repository
      for (let i = 0; i < existingRepos.length; i++) {
        const repo = existingRepos[i];
        console.log(`📊 Progress: ${i + 1}/${existingRepos.length}`);
        
        await this.deleteRepository(repo);
        
        // Add a small delay to avoid rate limiting
        if (i < existingRepos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Print summary
      this.printSummary();

    } catch (error) {
      console.error('💥 Cleanup failed:', error.message);
      process.exit(1);
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 CLEANUP SUMMARY');
    console.log('='.repeat(50));
    
    console.log(`🗑️ Deleted: ${this.results.deleted.length}`);
    console.log(`❓ Not Found: ${this.results.notFound.length}`);
    console.log(`❌ Failed: ${this.results.failed.length}`);

    if (this.results.deleted.length > 0) {
      console.log('\n✅ Successfully Deleted Repositories:');
      this.results.deleted.forEach(result => {
        console.log(`  • ${result.repoName} (${result.attendee.githubUsername})`);
      });
    }

    if (this.results.notFound.length > 0) {
      console.log('\n❓ Repositories Not Found:');
      this.results.notFound.forEach(result => {
        console.log(`  • ${result.repoName} (may have been already deleted)`);
      });
    }

    if (this.results.failed.length > 0) {
      console.log('\n❌ Failed to Delete:');
      this.results.failed.forEach(result => {
        console.log(`  • ${result.repoName} - ${result.error}`);
      });
    }

    // Write results to file
    const resultsFile = `cleanup-results-${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify(this.results, null, 2));
    console.log(`\n💾 Detailed results saved to: ${resultsFile}`);
    
    if (this.results.deleted.length > 0) {
      console.log('\n🎉 Repository cleanup completed successfully!');
    }
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const force = args.includes('--force') || args.includes('-f');

if (dryRun) {
  console.log('🔍 DRY RUN MODE - No repositories will be deleted\n');
}

// Run the script
if (require.main === module) {
  if (dryRun) {
    // Dry run - just show what would be deleted
    class DryRunCleanup extends WorkshopRepoCleanup {
      async confirmDeletion(repos) {
        if (repos.length === 0) {
          console.log('ℹ️ No repositories found that would be deleted');
          return false;
        }

        console.log('\n' + '='.repeat(60));
        console.log('🔍 REPOSITORIES THAT WOULD BE DELETED (DRY RUN)');
        console.log('='.repeat(60));
        
        repos.forEach((repo, index) => {
          console.log(`${index + 1}. ${CONFIG.targetOrg}/${repo.repoName}`);
          console.log(`   Owner: ${repo.attendee.githubUsername}`);
          console.log(`   Created: ${new Date(repo.createdAt).toLocaleString()}`);
          console.log(`   URL: ${repo.repoUrl}`);
          console.log('');
        });

        console.log('🔍 This is a dry run - no repositories were actually deleted');
        console.log('💡 Run without --dry-run to perform actual deletion');
        return false;
      }
    }
    
    const cleanup = new DryRunCleanup();
    cleanup.run().catch(error => {
      console.error('💥 Unexpected error:', error);
      process.exit(1);
    });
  } else {
    const cleanup = new WorkshopRepoCleanup();
    cleanup.run().catch(error => {
      console.error('💥 Unexpected error:', error);
      process.exit(1);
    });
  }
}

module.exports = WorkshopRepoCleanup;