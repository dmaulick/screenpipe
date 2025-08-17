# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Development Commands

### Building and Development
```bash
# Install dependencies
bun install

# Development server with turbopack
bun run dev

# Build for production
bun run build

# Start production server
bun run start

# Lint code
bun run lint

# Publish pipe to Screenpipe registry
bun run publish
```

### Project Structure
```
src/
├── app/                    # Next.js app directory
│   ├── api/               # API routes for pipe functionality
│   │   ├── log/           # Work log generation endpoint
│   │   ├── intelligence/  # AI analysis endpoint
│   │   ├── check-folder/  # Obsidian folder validation
│   │   ├── files/         # File system operations
│   │   └── obsidian-paths/# Obsidian vault discovery
│   ├── page.tsx           # Main settings interface
│   └── layout.tsx         # App layout wrapper
├── components/            # React components
│   ├── ui/               # shadcn/ui components
│   ├── obsidian-settings.tsx  # Main settings component
│   ├── ai-presets-selector.tsx
│   ├── file-suggest-textarea.tsx
│   └── markdown.tsx       # Markdown renderer
├── lib/                   # Utility libraries
│   ├── actions/          # Server actions
│   │   ├── obsidian.ts   # Obsidian file operations
│   │   ├── update-pipe-config.ts
│   │   └── video-actions.ts
│   ├── hooks/            # React hooks
│   ├── store/            # Global state management
│   │   └── settings-store.ts
│   ├── types.ts          # TypeScript type definitions
│   └── utils.ts          # Utility functions
```

## Architecture Overview

### Core Functionality
This is a **Screenpipe pipe** that integrates with Obsidian to create an automated knowledge base from screen/audio activity.

**Key Components:**
- **Work Log Generation**: Processes screen data every 5 minutes, generates structured logs using AI
- **Intelligence Analysis**: Creates higher-level insights from accumulated logs (hourly/daily summaries)
- **Obsidian Integration**: Automatically syncs generated content to Obsidian vault as markdown files
- **AI-Powered Analysis**: Uses configurable AI presets (OpenAI/local models) for content generation

### Data Flow
```
Screenpipe Data → AI Analysis → Structured Logs → Obsidian Vault
                              ↓
                         Intelligence Reports
```

### Automated Scheduling (pipe.json)
- **Work Logs**: Every 5 minutes (`0 */5 * * * *`) via `/api/log`
- **Intelligence**: Every hour (`0 0 */1 * * *`) via `/api/intelligence`

### Key Features
1. **Deduplication**: Uses embeddings (nomic-embed-text) to remove similar content
2. **Obsidian Link Extraction**: Processes `@[[note-name]]` references in prompts
3. **Media Integration**: Embeds video files from Screenpipe recordings
4. **Configurable AI Models**: Supports OpenAI API and local models via different presets

## Development Guidelines

### Technology Stack
- **Framework**: Next.js 15 with App Router
- **Runtime**: Bun for package management and execution
- **UI**: Tailwind CSS + shadcn/ui + Radix UI primitives
- **State**: Custom settings store with local persistence
- **AI Integration**: OpenAI SDK + Ollama provider
- **File Operations**: Node.js fs/promises for Obsidian vault manipulation

### Code Patterns
- **Server Actions**: Use "use server" for file system operations and AI calls
- **Client Components**: Use "use client" for interactive UI with hooks
- **Error Handling**: Return empty states rather than throwing, use toast for user feedback
- **File Paths**: Always use `path.normalize()` and `path.join()` for cross-platform compatibility
- **AI Responses**: Structure outputs as JSON objects with specific schemas

### Important Conventions
- **Obsidian URLs**: Use `obsidian://open?vault=NAME&file=PATH` format for deep links
- **Markdown Tables**: Escape pipe characters (`|`) with `\\|`, use `<br>` for newlines in cells
- **Video Embedding**: Use HTML `<video src="file://..." controls></video>` format
- **Note References**: Link using `[[note-name]]` format, support `@[[note]]` in prompts for content injection

### Settings Management
The pipe uses a hierarchical settings system:
- **Global Settings**: Screenpipe app-wide settings (AI presets, models)
- **Pipe Settings**: Specific to this Obsidian pipe (vault path, time windows, deduplication)
- **Persistence**: Settings stored via Screenpipe's configuration system

### File Generation Patterns
- **Work Logs**: Daily files in `{vault}/logs/YYYY-MM-DD.md` with table format
- **Intelligence**: Timestamped files in `{vault}/analyses/YYYY-MM-DD-HH-MM-analysis.md`
- **Content Structure**: Use level-3 headers (`###`), bullet points, and proper Obsidian formatting

## API Endpoints

### `/api/log` (Cron: Every 5 minutes)
- Queries Screenpipe for recent activity (configurable time window)
- Generates structured work log using AI
- Appends to daily log file in Obsidian vault
- Supports deduplication and content filtering

### `/api/intelligence` (Cron: Every hour)
- Reads recent log files from vault
- Creates higher-level analysis and insights
- Generates timestamped analysis file
- Processes note references and media links

### Configuration Endpoints
- `/api/check-folder`: Validates Obsidian vault path
- `/api/files`: File system operations
- `/api/obsidian-paths`: Auto-discovers Obsidian vaults

## Common Development Tasks

### Adding New AI Analysis Types
1. Extend the prompt templates in `/api/log` or `/api/intelligence`
2. Update the Zod schemas for structured output
3. Modify the Obsidian file writing logic for new formats
4. Add corresponding UI controls in `obsidian-settings.tsx`

### Modifying Obsidian Integration
- File operations are centralized in `src/lib/actions/obsidian.ts`
- Vault discovery logic handles multiple Obsidian installations
- Always test with different vault structures and file permissions

### Debugging Cron Jobs
- Check Screenpipe logs for pipe execution status
- API endpoints can be called manually for testing
- Use browser dev tools to monitor API responses during manual triggers