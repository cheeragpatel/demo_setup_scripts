#!/usr/bin/env node

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();

// Configuration
const CONFIG = {
  sourceOrg: process.env.SOURCE_ORG || 'your-source-org',
  sourceRepo: process.env.SOURCE_REPO || 'demo-repo',
  targetOrg: process.env.TARGET_ORG || 'your-target-org',
  csvFile: process.env.CSV_FILE || 'attendees.csv',
  githubToken: process.env.GITHUB_TOKEN,
};

async function validateConfiguration() {
  console.log('🔍 Validating Workshop Setup Configuration...\n');

  // Check GitHub token
  if (!CONFIG.githubToken) {
    console.error('❌ GITHUB_TOKEN is missing');
    return false;
  }
  console.log('✅ GitHub token provided');

  // Initialize Octokit
  const octokit = new Octokit({ auth: CONFIG.githubToken });

  try {
    // Test API access
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`✅ Authenticated as: ${user.login}`);
  } catch (error) {
    console.error('❌ GitHub authentication failed:', error.message);
    return false;
  }

  // Check source repository
  try {
    const { data: sourceRepo } = await octokit.rest.repos.get({
      owner: CONFIG.sourceOrg,
      repo: CONFIG.sourceRepo
    });
    console.log(`✅ Source repository found: ${sourceRepo.full_name}`);
    console.log(`   Default branch: ${sourceRepo.default_branch}`);
  } catch (error) {
    console.error(`❌ Source repository ${CONFIG.sourceOrg}/${CONFIG.sourceRepo} not found:`, error.message);
    return false;
  }

  // Check target organization
  try {
    const { data: org } = await octokit.rest.orgs.get({ org: CONFIG.targetOrg });
    console.log(`✅ Target organization found: ${org.login}`);
  } catch (error) {
    console.error(`❌ Target organization ${CONFIG.targetOrg} not found:`, error.message);
    return false;
  }

  // Check organization membership/permissions
  try {
    const { data: membership } = await octokit.rest.orgs.getMembershipForAuthenticatedUser({
      org: CONFIG.targetOrg
    });
    console.log(`✅ Organization membership: ${membership.role}`);
    
    if (membership.role !== 'admin') {
      console.warn('⚠️  Warning: You may need admin permissions to create repositories and add collaborators');
    }
  } catch (error) {
    console.warn('⚠️  Warning: Could not verify organization permissions');
  }

  // Check CSV file
  if (!fs.existsSync(CONFIG.csvFile)) {
    console.error(`❌ CSV file not found: ${CONFIG.csvFile}`);
    return false;
  }

  // Validate CSV content
  const attendees = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(CONFIG.csvFile)
      .pipe(csv())
      .on('data', (row) => {
        if (row.github_username) {
          attendees.push(row.github_username.trim());
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  if (attendees.length === 0) {
    console.error('❌ No valid attendees found in CSV file');
    return false;
  }

  console.log(`✅ CSV file validated with ${attendees.length} attendees`);

  // Check a few random attendee usernames
  const samplesToCheck = Math.min(3, attendees.length);
  console.log(`\n🔍 Validating sample GitHub usernames (${samplesToCheck} of ${attendees.length}):`);
  
  for (let i = 0; i < samplesToCheck; i++) {
    const username = attendees[i];
    try {
      await octokit.rest.users.getByUsername({ username });
      console.log(`   ✅ ${username} - valid GitHub user`);
    } catch (error) {
      console.log(`   ❌ ${username} - GitHub user not found`);
    }
  }

  // Check required branches in source repo
  console.log('\n🌿 Checking required branches in source repository:');
  const requiredBranches = ['main', 'feature-add-tos-download', 'feature-add-cart-page'];
  
  for (const branch of requiredBranches) {
    try {
      await octokit.rest.repos.getBranch({
        owner: CONFIG.sourceOrg,
        repo: CONFIG.sourceRepo,
        branch: branch
      });
      console.log(`   ✅ ${branch} - exists`);
    } catch (error) {
      if (branch === 'main') {
        console.log(`   ❌ ${branch} - missing (required)`);
      } else {
        console.log(`   ⚠️  ${branch} - will be created from main branch`);
      }
    }
  }

  console.log('\n✅ Configuration validation completed successfully!');
  console.log('\nConfiguration Summary:');
  console.log(`   Source: ${CONFIG.sourceOrg}/${CONFIG.sourceRepo}`);
  console.log(`   Target Org: ${CONFIG.targetOrg}`);
  console.log(`   Attendees: ${attendees.length}`);
  console.log(`   CSV File: ${CONFIG.csvFile}`);

  return true;
}

// Run validation
if (require.main === module) {
  validateConfiguration().catch(error => {
    console.error('💥 Validation failed:', error.message);
    process.exit(1);
  });
}

module.exports = { validateConfiguration };