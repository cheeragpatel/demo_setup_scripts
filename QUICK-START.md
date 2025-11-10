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
2. Fork from your source repository
3. Create required branches: `main`, `feature-add-tos-download`, `feature-add-cart-page`
4. Add the attendee as an admin collaborator

## 🆘 Need Help?

- Run `npm run validate` to check your setup
- Check the full [README.md](README.md) for detailed troubleshooting
- Verify your GitHub token has the correct permissions