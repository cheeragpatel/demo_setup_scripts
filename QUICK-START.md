# Quick Start Guide

## 🚀 Get Started in 5 Minutes

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment
```bash
cp .env.example .env
# Edit .env with your GitHub token and repository details
```

### 3. Prepare Attendee List
```bash
cp attendees.csv.example attendees.csv
# Edit attendees.csv with your workshop participants
```

### 4. Validate Configuration (Optional but Recommended)
```bash
npm run validate
```

### 5. Run the Setup
```bash
npm start
```

### 6. Clean Up After Workshop (Optional)
```bash
# Preview what will be deleted (recommended first)
npm run cleanup:dry-run

# Actually delete the repositories
npm run cleanup
```

## 📋 Required Information

Before running the script, you need:

1. **GitHub Personal Access Token** with permissions:
   - `repo` (Full control of private repositories)
   - `admin:org` (Full control of orgs and teams)

2. **Repository Details:**
   - Source organization and repository name
   - Target organization name

3. **Attendee List:**
   - CSV file with GitHub usernames

## 🔧 Example Configuration

**.env file:**
```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
SOURCE_ORG=my-company
SOURCE_REPO=workshop-demo
TARGET_ORG=workshop-2024
CSV_FILE=attendees.csv
```

**attendees.csv file:**
```csv
github_username,email
johndoe,john.doe@example.com
janesmith,jane.smith@example.com
```

## 📊 What Happens

For each attendee, the script will:
1. Create `{source-repo}-{github-username}` repository
2. Duplicate all content from your source repository (not a fork)
3. Copy all branches with complete history
4. Add the attendee as an admin collaborator

## 🧹 Cleanup Commands

After your workshop, you can clean up all created repositories:

```bash
# See what would be deleted (safe preview)
npm run cleanup:dry-run

# Actually delete repositories (requires confirmation)
npm run cleanup
```

## 🆘 Need Help?

- Run `npm run validate` to check your setup
- Check the full [README.md](README.md) for detailed troubleshooting
- Verify your GitHub token has the correct permissions