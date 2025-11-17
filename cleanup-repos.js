#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const csv = require('csv-parser');
const readline = require('readline');
require('dotenv').config();

// Configuration - Update these variables as needed
const CONFIG = {
  targetOrg: process.env.TARGET_ORG || 'your-target-org',
  csvFile: process.env.CSV_FILE || 'attendees.csv',
  githubToken: process.env.GITHUB_TOKEN,
  
  // Performance & Rate Limiting
  concurrentDeletions: parseInt(process.env.CONCURRENT_DELETIONS || '5'), // Delete N repos at once
  delayBetweenBatches: parseInt(process.env.DELAY_BETWEEN_BATCHES || '1000'), // ms delay between batches
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
    
    // Rate limit tracking
    this.apiCallCount = 0;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    
    // Get all repos in the organization
    try {
      const { data: allRepos } = await octokit.rest.repos.listForOrg({
        org: CONFIG.targetOrg,
        type: 'all',
        per_page: 100
      });
      
      // For each attendee, find repos that end with their username
      for (const attendee of attendees) {
        const suffix = `-${attendee.githubUsername}`;
        const attendeeRepos = allRepos.filter(repo => repo.name.endsWith(suffix));
        
        for (const repo of attendeeRepos) {
          existingRepos.push({
            attendee,
            repoName: repo.name,
            repoUrl: repo.html_url,
            createdAt: repo.created_at,
            updatedAt: repo.updated_at
          });
        }
      }
    } catch (error) {
      console.error(`❌ Error listing repositories: ${error.message}`);
      throw error;
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
    
    console.log(`  🗑️ Deleting: ${repoName}...`);
    
    try {
      this.apiCallCount++;
      await octokit.rest.repos.delete({
        owner: CONFIG.targetOrg,
        repo: repoName
      });
      
      console.log(`  ✅ Deleted: ${repoName}`);
      this.results.deleted.push(repoInfo);
      
    } catch (error) {
      if (error.status === 404) {
        console.log(`  ℹ️  Not found: ${repoName}`);
        this.results.notFound.push(repoInfo);
      } else {
        console.error(`  ❌ Failed: ${repoName} - ${error.message}`);
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

      // Delete repositories in batches with concurrency control
      const startTime = Date.now();
      
      for (let i = 0; i < existingRepos.length; i += CONFIG.concurrentDeletions) {
        const batch = existingRepos.slice(i, i + CONFIG.concurrentDeletions);
        const batchNum = Math.floor(i / CONFIG.concurrentDeletions) + 1;
        const totalBatches = Math.ceil(existingRepos.length / CONFIG.concurrentDeletions);
        
        console.log(`\n📊 Batch ${batchNum}/${totalBatches} - Deleting repositories ${i + 1}-${Math.min(i + CONFIG.concurrentDeletions, existingRepos.length)}/${existingRepos.length}`);
        
        // Delete batch concurrently
        const batchPromises = batch.map(repo => this.deleteRepository(repo));
        await Promise.all(batchPromises);
        
        // Calculate and display progress
        const processedCount = Math.min(i + CONFIG.concurrentDeletions, existingRepos.length);
        const percentComplete = Math.round((processedCount / existingRepos.length) * 100);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const avgTimePerRepo = elapsed / processedCount;
        const remaining = Math.round((existingRepos.length - processedCount) * avgTimePerRepo);
        
        console.log(`\n⏱️  Progress: ${percentComplete}% complete | Elapsed: ${elapsed}s | Est. remaining: ${remaining}s`);
        console.log(`   Deleted: ${this.results.deleted.length} | Not Found: ${this.results.notFound.length} | Failed: ${this.results.failed.length}`);
        
        // Delay between batches to avoid rate limiting
        if (i + CONFIG.concurrentDeletions < existingRepos.length) {
          console.log(`⏸️  Waiting ${CONFIG.delayBetweenBatches / 1000}s before next batch...`);
          await this.sleep(CONFIG.delayBetweenBatches);
        }
      }
      
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n✅ All repositories processed in ${totalTime}s (${Math.round(totalTime / 60)}m ${totalTime % 60}s)`);

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