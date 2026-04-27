# CodeTrack

CodeTrack is a coding exercise platform for teachers and students. Teachers can publish exercises, review student submissions, and leave progress feedback. Students can sign up, submit multiple attempts, and track improvement over time.

## Tech Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express
- Database: MongoDB Atlas
- Deployment: Vercel

## Features

- Teacher and student role-based workflow
- Login and signup flow
- Exercise publishing
- Student code submissions with multiple attempts
- Teacher review comments and score updates
- Progress discussion thread between teacher and student
- Notifications and activity tracking
- Contact form storage

## Project Structure

```text
CodeTrack project/
├── index.html              # Landing page
├── about.html              # About page
├── contact.html            # Contact page
├── faq.html                # FAQ page
├── login.html              # Login page
├── signup.html             # Signup page
├── exercises.html          # Teacher exercise workspace
├── submissions.html        # Submission and review view
├── progress.html           # Progress tracking view
├── styles.css              # Main styles
├── app.js                  # Auth and contact frontend logic
├── script.js               # Main dashboard/workspace frontend logic
├── theme.js                # Theme handling
├── server.js               # Express backend and MongoDB logic
├── api/index.js            # Vercel serverless entrypoint
├── data/store.json         # Older local data stub, not active database storage
├── DATABASE_SETUP.md       # MongoDB Atlas and Vercel setup notes
├── package.json            # Dependencies and scripts
└── vercel.json             # Vercel routing config
```

## Database

This project uses MongoDB Atlas.

Main collections used:

- `users`
- `login_events`
- `contact_messages`
- `exercises`
- `submissions`
- `review_comments`
- `progress_comments`
- `progress_comment_reads`
- `notifications`
- `activity_logs`
- `counters`

## API Endpoints

The frontend communicates with the backend using `/api` endpoints.

- `GET /api/state`
  - Fetches exercises, submissions, reviews, progress comments, notifications, and activity logs.
- `POST /api/auth`
  - Handles login and signup.
- `POST /api/contact`
  - Saves contact form messages.
- `POST /api/exercises`
  - Creates a new exercise. Teacher only.
- `POST /api/submissions`
  - Creates a student submission. Student only.
- `PATCH /api/submissions/:id/review`
  - Saves teacher review feedback and optional score.
- `POST /api/progress-comments`
  - Adds a progress discussion comment.
- `PATCH /api/progress-comments/:id`
  - Updates an existing progress comment.
- `DELETE /api/progress-comments/:id`
  - Deletes an existing progress comment.
- `POST /api/progress-comments/read`
  - Marks progress comments as read for a student.
- `POST /api/notifications/read`
  - Marks notifications as read.

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

Add the following values in a `.env` file in the project root:

```bash
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/codetrack?retryWrites=true&w=majority&appName=CodeTrack
MONGODB_DB=codetrack
PORT=3000
```

### 3. Start the project

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Deployment

This project is set up for Vercel.

- `api/index.js` boots the Express app in a serverless handler.
- `vercel.json` rewrites routes through the API entrypoint.

Set these environment variables in Vercel:

- `MONGODB_URI`
- `MONGODB_DB`

## Security Notes

Current security measures include:

- Restricted CORS origins
- Role-based route protection
- Input presence validation
- Request body size limit
- Frontend password confirmation and captcha during signup

Current limitations:

- Passwords are stored in plain text
- No JWT or session-based authentication
- Auth currently relies on client-provided headers and localStorage
- Frontend captcha is not server-verified

This is acceptable for a demo or classroom project, but not for production use without hardening.

## Default Demo Accounts

- Teacher: `teacher@example.com` / `teacher123`
- Student: `maya@example.com` / `student123`

## Notes

- `mongoose` is installed but the current backend uses the native MongoDB driver through `MongoClient`.
- `data/store.json` is not part of the active runtime data flow in the current version.
