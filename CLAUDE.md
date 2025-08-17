# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Development Commands

### Building
```bash
# Build Rust backend with platform-specific features
cargo build --release --features metal  # macOS (Apple Silicon)
cargo build --release --features cuda   # NVIDIA GPUs
cargo build --release                   # CPU-only

# Build desktop app (after Rust build)
cd screenpipe-app-tauri
bun install
bun tauri build
```

### Testing
```bash
cargo test                    # Run all Rust tests
cargo bench                  # Run benchmarks

# E2E testing (in screenpipe-app-tauri)
bun test:e2e                 # WebDriver tests
bun test:e2e:terminator      # Terminator integration tests

# Individual crate testing
cargo test -p screenpipe-core
cargo test -p screenpipe-server
cargo test -p screenpipe-vision
```

### Development
```bash
# Run backend only
./target/release/screenpipe

# Run with different port/data directory (avoid conflicts)
./target/release/screenpipe --port 3035 --data-dir /tmp/sp

# Run desktop app in dev mode
cd screenpipe-app-tauri
bun dev

# Development build (faster compilation)
cargo build --bin screenpipe

# Clean build artifacts
cd screenpipe-app-tauri && bun run clean
```

### Plugin Development
```bash
# Create new pipe (plugin)
bunx --bun @screenpipe/dev@latest pipe create

# Register and publish pipe
bunx --bun @screenpipe/dev@latest pipe register --name foo [--paid --price 50]
bun run build
bunx --bun @screenpipe/dev@latest pipe publish --name foo
```

## Architecture Overview

### Core Components
- **screenpipe-server**: Main HTTP server (port 3030), orchestrates recording & API
- **screenpipe-vision**: Screen capture, OCR processing, window monitoring  
- **screenpipe-audio**: Audio recording, speech-to-text, speaker identification
- **screenpipe-db**: SQLite database layer with FTS5 search
- **screenpipe-core**: Shared utilities (FFmpeg, LLM integrations, pipes system)
- **screenpipe-app-tauri**: Desktop app (Rust backend + Next.js frontend)

### Data Flow
```
Screen Capture → OCR → Database → API/WebSocket
Audio Recording → STT → Speaker ID → Database → API/WebSocket  
```

### Plugin System ("Pipes")
- External processes (Node.js/Bun) with own ports
- Access data via HTTP API (localhost:3030)
- Configuration in `~/.screenpipe/pipes/`
- Support web UI (Next.js) and background processing

### Database Schema
- **frames**: Screen capture metadata with timestamps, app/window info
- **ocr_text**: Extracted text from frames (searchable via FTS5)
- **audio_transcriptions**: Speech-to-text with speaker identification
- **speakers**: Voice identity clustering and metadata
- Location: `$HOME/.screenpipe/db.sqlite`

## Development Guidelines

### Code Style (from .cursorrules)
- **Rust**: Use anyhow errors, prefer tokio over std, avoid mutex (use channels)
- **Frontend**: TypeScript + Next.js + Tailwind + shadcn + Lucide icons + MagicUI + Framer Motion
- **Logging**: Lowercase for logging and UI text
- **Error handling**: Use empty states and skeletons, avoid toast notifications (never use toast errors)
- **HTML/React**: Proper escaping with &apos; instead of " when inside quotes
- **Code Comments**: Do not remove @ts-ignore unless explicitly asked
- Keep files under 600 lines when possible
- When providing full code, provide COMPLETE implementations without "// rest of code" comments

### Key Patterns
- **Concurrency**: Channels over mutexes/locks
- **Plugin Architecture**: External processes with HTTP/WebSocket communication  
- **Event-Driven**: WebSocket streams for real-time data
- **Resource Monitoring**: Built-in health checks and auto-recovery

### Important Paths
- Database: `$HOME/.screenpipe/db.sqlite`  
- Video files: `$HOME/.screenpipe/*.mp4`
- Pipes config: `$HOME/.screenpipe/pipes/`
- Logs: `$HOME/.screenpipe/` (platform-specific)

## Common Tasks

### Database Queries
Use FTS5 tables for text search, filter by time first:
```sql
-- Search OCR text with context
SELECT f.timestamp, f.app_name, f.window_name, o.text
FROM ocr_text_fts ft
JOIN ocr_text o ON o.frame_id = ft.frame_id  
JOIN frames f ON f.id = o.frame_id
WHERE julianday(f.timestamp) >= julianday('now','-3 hours')
  AND ft MATCH 'search query'
ORDER BY f.timestamp DESC LIMIT 50;
```

### Debugging
```bash
# Memory debugging
RUSTFLAGS="-Z sanitizer=address" cargo run --bin screenpipe

# Performance monitoring  
cargo install cargo-instruments
cargo instruments -t Leaks --bin screenpipe --features metal --time-limit 600000

# Tokio console debugging
RUST_LOG="tokio=debug,runtime=debug" RUSTFLAGS="--cfg tokio_unstable" cargo run --bin screenpipe --features debug-console
```

### Database Migrations
```bash
cargo install sqlx-cli
sqlx migrate add <migration_name>

# Fix migration issues
sqlite3 ~/.screenpipe/db.sqlite "DELETE FROM _sqlx_migrations WHERE version = XXXXXXXXXX;"
```

## Project Structure
- **Workspace**: Multiple Rust crates in workspace configuration
- **Desktop App**: Tauri app spawns Rust backend as sidecar process
- **API**: REST endpoints on localhost:3030 with WebSocket support
- **Plugins**: External processes managed by PipeManager
- **Frontend**: Next.js app embedded in Tauri webview

## Dependencies
- **AI/ML**: Candle framework for local inference, HuggingFace Hub, Tokenizers
- **Audio/Video**: FFmpeg, Whisper, voice activity detection  
- **Database**: SQLite with FTS5 full-text search, SQLx for migrations
- **UI**: Tauri, Next.js 15+, Tailwind CSS, Radix UI, shadcn/ui, Lucide icons, MagicUI, Framer Motion
- **State Management**: Zustand, Easy Peasy
- **Build**: Bun for JavaScript, Cargo for Rust
- **Testing**: WebDriver for E2E tests, Mocha for Terminator tests
- **Monitoring**: Sentry for error tracking, PostHog for analytics