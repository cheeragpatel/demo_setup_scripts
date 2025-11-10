# Workshop Repository Setup Script

This script automatically creates demo repositories for workshop attendees by forking a source repository and setting up the required branches for each participant.

## Features

- 🍴 Forks a source repository for each attendee
- 🌿 Creates required branches (`main`, `feature-add-tos-download`, `feature-add-cart-page`)
- 👤 Adds attendees as admin collaborators to their repositories
- ⏭️ Skips repositories that already exist
- 📊 Provides detailed progress reporting and summary
- 💾 Saves results to a JSON file for record keeping

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
# GitHub Personal Access Token
GITHUB_TOKEN=ghp_your_token_here

# Source repository to fork from
SOURCE_ORG=my-company
SOURCE_REPO=workshop-demo

# Target organization where new repos will be created
TARGET_ORG=workshop-2024

# CSV file with attendee information
CSV_FILE=attendees.csv
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

### Basic Usage

```bash
npm start
```

Or directly with Node.js:

```bash
node setup-repos.js
```

### What the Script Does

For each attendee, the script will:

1. 🔍 Check if repository `{source-repo}-{github-username}` already exists
2. 🍴 Fork the source repository to the target organization
3. 🌿 Create the required branches from the source repository
4. 👤 Add the attendee as an admin collaborator
5. ✅ Report success or ❌ log any errors

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
🍴 Forking repository to workshop-2024/workshop-demo-johndoe...
⏳ Waiting for repository workshop-demo-johndoe to be ready...
✅ Repository is ready
🌿 Creating required branches for workshop-demo-johndoe...
  ✅ Created branch: feature-add-tos-download
  ✅ Created branch: feature-add-cart-page
👤 Adding johndoe as owner of workshop-demo-johndoe...
✅ Added johndoe as admin collaborator
✅ Successfully set up repository: workshop-2024/workshop-demo-johndoe
```

## Output Files

The script generates:

1. **Console output**: Real-time progress and status updates
2. **Results JSON file**: `setup-results-YYYY-MM-DD.json` with detailed results including:
   - Successfully created repositories with URLs
   - Skipped repositories (if they already existed)
   - Failed repositories with error details

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

## Security Notes

- Keep your GitHub token secure and never commit it to version control
- The `.env` file is already in `.gitignore`
- Attendees will receive admin access to their repositories
- Consider the implications of forking private repositories

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