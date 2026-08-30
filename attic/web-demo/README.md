# ArtiPod Web Demo

A full-stack web application demonstrating the ArtiPod library's capabilities, including filesystem management, mount aggregation, and Docker container execution.

## Features

- **Filesystem Management**: Create folders and files in the workspace
- **ArtiPod Creation**: Create pods with multiple mounts
- **Mount Operations**: Add mounts to pods, manage files within mounts
- **File Browser**: View and edit files across all mounts in a pod
- **Container Execution**: Start Docker containers and execute bash commands
- **Real-time Terminal**: Interactive command execution with stdout/stderr display

## Architecture

- **Backend**: Express.js API with SQLite persistence
- **Frontend**: React with Vite, TanStack Query for state management
- **Storage**: Better-sqlite3 for pod/mount/container state
- **Container**: Dockerode for container management

## Prerequisites

- Node.js >= 18.0.0
- Docker Desktop or Docker Engine running
- npm or yarn

## Setup

### 1. Install root dependencies

From the ArtiPod root directory:

```bash
npm install
npm run build
```

### 2. Install demo dependencies

```bash
cd examples/web-demo
npm run install:all
```

This will install dependencies for the root package, backend, and frontend.

## Running the Application

### Development Mode (Recommended)

From the `examples/web-demo` directory:

```bash
npm run dev
```

This starts both:
- Backend API server on http://localhost:3001
- Frontend dev server on http://localhost:5173

Open http://localhost:5173 in your browser.

### Production Mode

```bash
npm run build
npm start
```

Backend runs on http://localhost:3001, serving the built frontend.

## Usage Guide

### 1. Create Filesystem Structure

- Navigate to the **Filesystem** tab
- Create folders: e.g., `my-project/src`, `my-project/docs`
- Create files: e.g., `my-project/src/index.ts`

### 2. Create an ArtiPod

- In the **Filesystem** tab, scroll to "Create ArtiPod"
- Enter a pod name
- Add mounts:
  - Mount name: `src` → Folder path: `my-project/src`
  - Mount name: `docs` → Folder path: `my-project/docs`
- Click "Create Pod"

### 3. Manage Pod Files

- Select your pod from the sidebar
- Navigate to **Pod Manager** tab
- Add new mounts if needed
- Create files in mounts
- Click files to edit them

### 4. Execute Commands

- Click "Start Container" in the Pod Manager
- Navigate to **Container** tab
- Type bash commands and press Execute
- Commands run in an isolated Alpine Linux container
- All mount contents are available in `/context/<mount-name>/`

### Example Commands

```bash
# List all files
ls -la

# Navigate to a mount
cd src && ls

# Create a file
echo "Hello from container" > output.txt

# Run a script
cat index.ts

# System info
uname -a
```

## Project Structure

```
web-demo/
├── backend/
│   ├── src/
│   │   ├── server.ts          # Express API
│   │   ├── database.ts        # SQLite schema and queries
│   │   └── podManager.ts      # ArtiPod instance management
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/        # React components
│   │   ├── App.tsx           # Main app
│   │   ├── api.ts            # API client
│   │   └── main.tsx          # Entry point
│   └── package.json
├── workspace/                 # Created at runtime
│   ├── artipod.db            # SQLite database
│   └── <user-created-files>  # User's filesystem
└── package.json              # Root scripts
```

## API Endpoints

### Filesystem
- `POST /api/fs/folder` - Create folder
- `POST /api/fs/file` - Create file
- `GET /api/fs/tree` - Get file tree

### Pods
- `GET /api/pods` - List all pods
- `POST /api/pods` - Create pod
- `GET /api/pods/:id` - Get pod details
- `DELETE /api/pods/:id` - Delete pod

### Mounts
- `POST /api/pods/:id/mounts` - Add mount to pod

### Files
- `GET /api/pods/:id/files` - Get all files in pod's mounts
- `POST /api/pods/:id/files` - Create file in mount
- `GET /api/pods/:id/files/:mountName/*` - Get file content
- `PUT /api/pods/:id/files/:mountName/*` - Update file

### Container
- `POST /api/pods/:id/container/start` - Start container
- `POST /api/pods/:id/container/exec` - Execute command
- `POST /api/pods/:id/container/stop` - Stop container

## Troubleshooting

### Docker Connection Issues

Ensure Docker Desktop is running:
```bash
docker ps
```

### Port Already in Use

Backend (3001) or Frontend (5173) ports occupied:
```bash
# Kill process on port
lsof -ti:3001 | xargs kill -9
lsof -ti:5173 | xargs kill -9
```

### Module Not Found

Rebuild the parent ArtiPod module:
```bash
cd ../..
npm run build
cd examples/web-demo
npm run install:all
```

## Technologies Used

- **Backend**: Express, Better-sqlite3, Dockerode, nanoid
- **Frontend**: React, Vite, TanStack Query, TypeScript
- **ArtiPod**: Local file:../../.. dependency

## License

MIT (same as parent ArtiPod project)
