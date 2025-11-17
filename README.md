# Workshop Repository Setup Script

This script automatically creates demo repositories for workshop attendees by forking a source repository and setting up the required branches for each participant.

## Features

- 📦 Creates complete duplicate repositories (not forks) for each attendee with **internal visibility**
- 🌿 Copies all branches from source repository (`main`, `feature-add-tos-download`, `feature-add-cart-page`)
- 📋 Preserves all files, commit history, and branch structure
- 👤 Adds attendees as admin collaborators to their repositories
- 🚀 **Prebuilds GitHub Codespaces for fast startup times**
- ⏭️ Skips repositories that already exist
- 🧹 **Cleanup functionality to delete all workshop repositories**
- 📊 Provides detailed progress reporting and summary
- 💾 Saves results to a JSON file for record keeping
- 🔍 Dry-run mode for cleanup to preview what will be deleted

## Prerequisites

1. **Node.js** (version 16 or higher)
2. **GitHub Personal Access Token** with the following permissions:
   - `repo` (Full control of private repositories)
   - `admin:org` (Full control of orgs and teams, read and write org projects)
3. **Admin access** to the target organization where repositories will be created
4. **Access** to the source repository that will be forked

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file and update it with your values:

```bash
cp .env.example .env
```

Edit `.env` file with your specific configuration:

```env
# GitHub Personal Access Token with repo, admin:org, and workflow permissions
#   -- delete_repo scope is also needed if you plan to run the cleanup script
GITHUB_TOKEN=your_github_token_here

# Release Package Configuration
RELEASE_TARBALL=./workshop-release.tar.gz

# Target organization where new repos will be created
TARGET_ORG=your-target-org

# CSV file containing attendee information
CSV_FILE=attendees.csv

# Working Directory (temporary files)
WORKING_DIR=./temp-release-setup

# Enable Codespaces prebuilds (true/false)
ENABLE_CODESPACES_PREBUILDS=true

# Performance & Rate Limiting Configuration
# For 100-150 attendees, these settings are optimized
CONCURRENT_ATTENDEES=5          # Process N attendees simultaneously
CONCURRENT_REPOS=3              # Process N repos per attendee simultaneously
DELAY_BETWEEN_BATCHES=2000      # Milliseconds delay between batches
RATE_LIMIT_BUFFER=100           # Keep this many API calls in reserve
RETRY_ATTEMPTS=3                # Number of retries for failed operations
RETRY_DELAY=5000                # Milliseconds between retries

```

### 3. Prepare Attendee List

Create a CSV file with attendee information. Use the provided example as a template:

```bash
cp attendees.csv.example attendees.csv
```

Edit `attendees.csv` with your attendee information:

```csv
github_username,email
johndoe,john.doe@example.com
janesmith,jane.smith@example.com
bobwilson,bob.wilson@example.com
```

**Required columns:**
- `github_username`: The GitHub username of the attendee
- `email`: (Optional) Email address for reference

### 4. Verify Source Repository

Ensure your source repository exists and has the required branches:
- `main` (default branch)
- `feature-add-tos-download`
- `feature-add-cart-page`

If the feature branches don't exist in the source repository, the script will create them from the main branch.

## Running the Script

### Repository Setup

Create repositories for all attendees:

```bash
npm start
```

Or directly with Node.js:

```bash
node setup-repos.js
```

### Repository Cleanup

⚠️ **WARNING: Cleanup will permanently delete repositories and cannot be undone!**

#### Dry Run (Recommended First)
Preview what repositories will be deleted without actually deleting them:

```bash
npm run cleanup:dry-run
```

#### Actual Cleanup
Delete all workshop repositories:

```bash
npm run cleanup
```

Or with alternative commands:

```bash
# Using the cleanup script directly
node cleanup-repos.js

# Using the main script with cleanup flag
node setup-repos.js --cleanup
```

### What the Cleanup Script Does

The cleanup process will:

1. 🔍 Scan the target organization for repositories matching the pattern `{source-repo}-{github-username}`
2. 📋 Display a list of repositories that will be deleted with their details
3. ⚠️ Require explicit confirmation (you must type "DELETE" to proceed)
4. 🗑️ Delete each repository permanently
5. 📊 Provide a detailed summary of the cleanup results

### What the Setup Script Does

For each attendee, the script will:

1. 🔍 Check if repository `{source-repo}-{github-username}` already exists
2. 📦 Create a new empty repository in the target organization with **internal visibility**
3. 🔄 Clone all content, branches, and commit history from the source repository using efficient git commands
4. 🌿 Push only the required branches (`main`, `feature-add-tos-download`, `feature-add-cart-page`)
5. 👤 Add the attendee as an admin collaborator
6. 🚀 **Setup and trigger Codespaces prebuilds for fast environment startup**
7. ✅ Report success or ❌ log any errors

### Example Output

```
🎯 Workshop Repository Setup Starting...

🔍 Validating configuration...
✅ Source repository validated
✅ Target organization validated
📖 Loading attendees from attendees.csv...
✅ Loaded 5 attendees

📊 Progress: 1/5

🚀 Setting up repository for johndoe...
📦 Creating duplicate repository your-target-org/workshop-demo-johndoe...
✅ Created empty repository: your-target-org/workshop-demo-johndoe
🔄 Cloning content from your-source-org/workshop-demo...
📋 Cloning 3 required branches: main, feature-add-tos-download, feature-add-cart-page
🌿 Cloning branch: main (first branch)...
  📄 Processing 25 files...
  🔄 Processing files 1-20...
  🔄 Processing files 21-25...
  ✅ Successfully processed 25 files
  ✅ Cloned branch: main (25 files)
🌿 Cloning branch: feature-add-tos-download...
  📄 Processing 26 files...
  ✅ Successfully processed 26 files
  ✅ Cloned branch: feature-add-tos-download (26 files)
🌿 Cloning branch: feature-add-cart-page...
  📄 Processing 28 files...
  ✅ Successfully processed 28 files
  ✅ Cloned branch: feature-add-cart-page (28 files)
👤 Adding johndoe as owner of workshop-demo-johndoe...
✅ Added johndoe as admin collaborator
🚀 Setting up Codespaces prebuilds for workshop-demo-johndoe...
  ✅ Found .devcontainer configuration
  🔧 Enabling Codespaces for repository...
  ✅ Codespaces enabled for repository
  🏗️ Creating prebuild configuration for branch: main
  ✅ Prebuild configuration created for main (ID: 12345)
  ℹ️ Prebuild will only trigger on devcontainer configuration changes
  🔍 Checking for existing prebuild configurations...
  ✅ Found 1 prebuild configuration(s)
  ℹ️ Initial prebuild will be triggered automatically when devcontainer config is detected
  ⚡ Triggering initial prebuild for new repository...
  🚀 Initial prebuild triggered (will complete in background)
  ✅ Codespaces setup completed for workshop-demo-johndoe
✅ Successfully set up repository: your-target-org/workshop-demo-johndoe
```

## Output Files

The scripts generate:

1. **Console output**: Real-time progress and status updates
2. **Setup Results**: `setup-results-YYYY-MM-DD.json` with detailed results including:
   - Successfully created repositories with URLs
   - Skipped repositories (if they already existed)
   - Failed repositories with error details
3. **Cleanup Results**: `cleanup-results-YYYY-MM-DD.json` with detailed cleanup results including:
   - Successfully deleted repositories
   - Repositories not found (may have been already deleted)
   - Failed deletions with error details

## Troubleshooting

### Common Issues

**Authentication Error**
```
Error: Bad credentials
```
- Verify your `GITHUB_TOKEN` is correct and has the required permissions

**Repository Not Found**
```
Source repository not found or not accessible
```
- Check that `SOURCE_ORG` and `SOURCE_REPO` are correct
- Ensure your token has access to the source repository

**Organization Access Error**
```
Target organization not found or not accessible
```
- Verify `TARGET_ORG` is correct
- Ensure you have admin access to the target organization

**Rate Limiting**
```
API rate limit exceeded
```
- The script includes delays between operations to minimize rate limiting
- If you hit limits, wait and re-run the script (it will skip existing repositories)

### CSV Format Issues

Ensure your CSV file:
- Has a header row with `github_username` column
- Contains valid GitHub usernames
- Uses UTF-8 encoding
- Has no empty rows

## Advanced Configuration

You can override environment variables when running the script:

```bash
SOURCE_ORG=different-org TARGET_ORG=other-org npm start
```

Or modify the configuration object in `setup-repos.js` for more permanent changes.

## GitHub Codespaces Prebuild Configuration

The script automatically configures Codespaces prebuilds with the following optimized settings:

- **Branch Target**: Only the `main` branch (not feature branches)
- **Trigger Policy**: Only rebuilds when devcontainer configuration changes
- **No Automatic Rebuilds**: Prevents unnecessary rebuilds on every code push
- **Efficient Resource Usage**: Reduces compute costs by building only when needed

### Prebuild Triggers

Prebuilds will **only** be triggered when:
- ✅ Devcontainer configuration files change (`.devcontainer/devcontainer.json`, `.devcontainer/Dockerfile`, etc.)
- ✅ Initial setup of a new repository (one-time trigger)

Prebuilds will **NOT** be triggered on:
- ❌ Regular code commits and pushes
- ❌ Pull request creation or updates
- ❌ Changes to non-devcontainer files

## Security Notes

- Keep your GitHub token secure and never commit it to version control
- The `.env` file is already in `.gitignore`
- Attendees will receive admin access to their duplicate repositories
- Consider the implications of duplicating private repositories (all content will be copied)
- Workshop attendees will NOT see any connection to the original repository (unlike forks)

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review the generated JSON results file for detailed error information
3. Verify your GitHub token permissions
4. Ensure all repository and organization names are correct

## Script Architecture

The script is built using:
- **@octokit/rest**: Official GitHub REST API client
- **csv-parser**: For reading attendee CSV files
- **dotenv**: For environment variable management

The main class `WorkshopRepoSetup` handles:
- Configuration validation
- CSV parsing
- Repository operations (fork, branch creation, collaborator management)
- Error handling and reporting