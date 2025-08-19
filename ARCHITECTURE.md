# Screenpipe Architecture Documentation

## Executive Summary

Screenpipe is a sophisticated, multi-component system designed for comprehensive digital activity monitoring and analysis. It captures screen content, audio, and system interactions in real-time, processes them through OCR and speech-to-text engines, stores everything in a searchable database, and provides APIs for external integrations.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tauri Desktop Application                     │
│  ┌──────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   Next.js UI     │  │  Tauri Runtime  │  │   Sidecar      │ │
│  │   (Frontend)     │  │   (Rust)        │  │  Processes     │ │
│  └──────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                   │
                              HTTP/WebSocket
                                   │
┌─────────────────────────────────────────────────────────────────┐
│                     Screenpipe Server                           │
│                      (localhost:3030)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Core Components                        │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐│  │
│  │  │   Vision   │ │   Audio    │ │    Database Manager   ││  │
│  │  │  Capture   │ │  Manager   │ │      (SQLite)        ││  │
│  │  └────────────┘ └────────────┘ └────────────────────────┘│  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐│  │
│  │  │    OCR     │ │    STT     │ │    Pipe Manager       ││  │
│  │  │  Engine    │ │  Engine    │ │   (Plugin System)     ││  │
│  │  └────────────┘ └────────────┘ └────────────────────────┘│  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                   │
                          External Plugins/APIs
                                   │
┌─────────────────────────────────────────────────────────────────┐
│                        Pipes Ecosystem                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│  │   Meeting   │ │   Search    │ │   Memory    │ │    AI     │ │
│  │     Pipe    │ │    Pipe     │ │    Pipe     │ │   Pipe    │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components Deep Dive

### 1. screenpipe-server (Main Orchestrator)
**Location**: `screenpipe-server/src/`  
**Primary Role**: Central HTTP server and coordination hub

#### Key Modules:
- **server.rs**: Axum-based HTTP server with REST API and WebSocket support
- **core.rs**: Continuous recording orchestration and task management
- **pipe_manager.rs**: External plugin/process management
- **resource_monitor.rs**: System resource monitoring and auto-recovery

#### Technical Details:
- **Port**: 3030 (HTTP server)
- **Concurrency**: Tokio-based async runtime with structured concurrency
- **APIs**: RESTful endpoints + WebSocket streams for real-time data
- **State Management**: Arc-wrapped shared state with DatabaseManager, AudioManager, PipeManager
- **Error Recovery**: Built-in restart mechanisms for failed components

#### Key Functions:
```rust
// screenpipe-server/src/core.rs:16
pub async fn start_continuous_recording(
    db: Arc<DatabaseManager>,
    output_path: Arc<String>,
    fps: f64,
    ocr_engine: Arc<OcrEngine>,
    // ... other parameters
) -> Result<()>
```

### 2. screenpipe-vision (Screen Capture & OCR)
**Location**: `screenpipe-vision/src/`  
**Primary Role**: Screen capture, OCR processing, UI element monitoring

#### Platform-Specific Implementations:
- **apple.rs**: macOS Vision framework integration for high-performance OCR
- **microsoft.rs**: Windows OCR API integration  
- **tesseract.rs**: Cross-platform Tesseract OCR fallback
- **custom_ocr.rs**: Cloud-based OCR services integration

#### Technical Architecture:
- **Monitor Management**: Multi-monitor support with independent capture threads
- **Image Processing**: Real-time screenshot comparison and change detection
- **OCR Engines**: Multiple engine support (Apple Vision, Tesseract, Custom)
- **Window Filtering**: Configurable window inclusion/exclusion rules

#### Key Data Structures:
```rust
// screenpipe-vision/src/core.rs:102
pub struct CaptureResult {
    pub image: Option<DynamicImage>,
    pub text: String,
    pub timestamp: Instant,
    pub window_name: String,
    pub app_name: String,
    // ... other fields
}
```

#### Performance Features:
- **Intelligent Capture**: Only processes frames when screen content changes
- **Concurrent Processing**: Per-monitor async task isolation
- **Memory Management**: LRU caching for processed frames
- **Platform Optimization**: Native APIs for maximum performance

### 3. screenpipe-audio (Recording & Speech-to-Text)
**Location**: `screenpipe-audio/src/`  
**Primary Role**: Audio capture, speech recognition, speaker identification

#### Core Architecture:
- **audio_manager/**: Device management and stream coordination
- **core/engine.rs**: Audio processing engine with multiple STT backends
- **speaker/**: Voice embedding and speaker identification system
- **segmentation/**: Audio segmentation for improved transcription accuracy

#### STT Engine Support:
```rust
// screenpipe-audio/src/core/engine.rs:4
pub enum AudioTranscriptionEngine {
    Deepgram,
    WhisperTiny,
    WhisperLargeV3Turbo,
    WhisperLargeV3TurboQuantized,
    // ... other variants
}
```

#### Technical Features:
- **Multi-Device**: Simultaneous input/output audio capture
- **Voice Activity Detection**: Reduces processing overhead
- **Speaker Diarization**: ONNX-based speaker embedding models
- **Chunk Processing**: Time-segmented processing for better accuracy
- **Real-time Processing**: Streaming transcription with configurable latency

#### Speaker Identification Pipeline:
1. **Audio Segmentation**: VAD-based segment extraction
2. **Embedding Generation**: WeSpeaker model for voice fingerprints
3. **Clustering**: Dynamic speaker identity clustering
4. **Database Storage**: Persistent speaker profiles with metadata

### 4. screenpipe-db (Database & Search)
**Location**: `screenpipe-db/src/`  
**Primary Role**: SQLite database with full-text search capabilities

#### Database Schema:
```sql
-- Core Tables
frames                 -- Screen capture metadata
ocr_text              -- Extracted text from frames  
audio_transcriptions  -- Speech-to-text results
speakers              -- Voice identity clustering
audio_chunks          -- Audio file metadata
```

#### Technical Implementation:
- **SQLite with Extensions**: FTS5 for full-text search, WAL mode for concurrency
- **Connection Pooling**: sqlx with optimized pool configuration
- **Migration System**: Versioned schema migrations with rollback support
- **Vector Storage**: sqlite-vec extension for embedding storage

#### Performance Optimizations:
```rust
// screenpipe-db/src/db.rs:54-75
let pool = SqlitePoolOptions::new()
    .max_connections(50)
    .min_connections(3)
    .acquire_timeout(Duration::from_secs(10))
    .connect(&connection_string)
    .await?;

// WAL mode for concurrent reads/writes
sqlx::query("PRAGMA journal_mode = WAL;")
    .execute(&pool).await?;
```

#### Search Capabilities:
- **FTS5 Integration**: Fast full-text search across OCR and transcription data
- **Temporal Filtering**: Efficient time-range queries with proper indexing
- **Embedding Search**: Vector similarity search for semantic queries
- **Cross-Modal**: Unified search across text and audio content

### 5. screenpipe-core (Shared Utilities)
**Location**: `screenpipe-core/src/`  
**Primary Role**: Common utilities, LLM integration, plugin system

#### Key Modules:
- **pipes.rs**: Plugin architecture and lifecycle management
- **llm.rs**: Large language model integration (Llama, Phi, Mistral)
- **ffmpeg.rs**: Video processing and encoding utilities
- **network.rs**: HTTP client utilities and caching

#### Plugin Architecture:
```rust
// screenpipe-core/src/pipes.rs:44-47
pub enum PipeState {
    Port(u16),  // External web service
    Pid(i32),   // Background process
}
```

#### LLM Integration Features:
- **Multiple Backends**: Support for local and cloud LLM providers
- **OpenAI-Compatible**: Standardized API interface
- **Context Management**: Conversation state and token management
- **Streaming Support**: Real-time response generation

### 6. screenpipe-app-tauri (Desktop Application)
**Location**: `screenpipe-app-tauri/`  
**Primary Role**: Cross-platform desktop interface

#### Architecture:
- **Frontend**: Next.js 15+ with TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Tauri (Rust) with native system integration
- **State Management**: Zustand for React state
- **Communication**: HTTP API client + WebSocket connections

#### Tauri Integration:
```rust
// screenpipe-app-tauri/src-tauri/src/main.rs:59-63
pub use server::spawn_server;
pub use sidecar::spawn_screenpipe;
pub use sidecar::stop_screenpipe;
```

#### Key Features:
- **System Tray**: Background operation with status indicators
- **Permissions**: Native permission dialogs and system integration
- **Updates**: Auto-updater with differential patches
- **Shortcuts**: Global keyboard shortcuts for quick access
- **Sidecar Management**: Automatic Rust backend process lifecycle

## Data Flow Architecture

### 1. Capture Pipeline
```
Screen/Audio Input → Capture Process → OCR/STT Processing → Database Storage
```

#### Detailed Flow:
1. **Vision Capture**: `screenpipe-vision` captures screenshots per monitor
2. **Change Detection**: Compares frames to avoid redundant processing
3. **OCR Processing**: Extracts text using platform-specific engines
4. **Database Write**: Stores frame metadata and OCR results
5. **WebSocket Broadcast**: Real-time updates to connected clients

### 2. Audio Pipeline
```
Audio Device → Segmentation → STT → Speaker ID → Database → Search Index
```

#### Processing Steps:
1. **Device Capture**: Multi-device audio stream capture
2. **VAD Segmentation**: Voice activity detection for chunk boundaries
3. **Transcription**: Speech-to-text using configurable engines
4. **Speaker Analysis**: Voice embedding generation and clustering
5. **Database Storage**: Transcription and speaker metadata persistence

### 3. Plugin Communication
```
Pipe Manager → External Process → HTTP API → Database Query → Response
```

#### Plugin Lifecycle:
1. **Discovery**: Scan `~/.screenpipe/pipes/` for configurations
2. **Spawning**: Launch Node.js/Bun processes with allocated ports
3. **Registration**: Establish HTTP communication channels
4. **Data Access**: Plugins query main API for historical data
5. **Real-time Updates**: WebSocket subscriptions for live data

## Performance & Scalability

### Concurrency Model
- **Tokio Runtime**: Structured async concurrency
- **Channel-Based**: MPSC channels over mutex/locks for state sharing
- **Per-Component Isolation**: Independent task spawning for each subsystem

### Memory Management
- **LRU Caches**: Frame image cache with configurable size limits
- **Stream Processing**: Chunk-based audio processing to limit memory usage
- **Database Pooling**: Connection reuse with automatic cleanup

### Storage Optimization
- **WAL Mode**: SQLite Write-Ahead Logging for concurrent access
- **FTS5 Indexing**: Optimized full-text search indices
- **Compression**: Video chunk compression with FFmpeg
- **Retention Policies**: Configurable data retention and cleanup

## Security Considerations

### Data Privacy
- **Local Processing**: All data processing occurs locally by default
- **PII Removal**: Optional personally identifiable information filtering
- **Encryption**: Database encryption at rest (configurable)
- **Network Isolation**: No external data transmission unless explicitly configured

### Permission Model
- **Screen Recording**: macOS/Windows native permission requests
- **Microphone Access**: Audio device permission management
- **File System**: Controlled access to screenpipe directories only

## Extension Architecture (Pipes)

### Plugin Development
```typescript
// pipes/example-pipe/pipe.json
{
  "name": "example-pipe",
  "version": "1.0.0",
  "main": "app/page.tsx",
  "type": "web-ui"
}
```

### Communication Protocol
- **HTTP API**: REST endpoints for data queries
- **WebSocket**: Real-time data streams
- **Port Allocation**: Dynamic port assignment for isolation

### Development Workflow
```bash
# Create new pipe
bunx --bun @screenpipe/dev@latest pipe create

# Development server
bun dev  # Runs Next.js development server

# Register and publish
bunx --bun @screenpipe/dev@latest pipe register --name foo
```

## Deployment Architecture

### Build System
- **Cargo Workspace**: Unified Rust compilation
- **Tauri Bundling**: Native app packaging per platform
- **NSIS/DMG/AppImage**: Platform-specific installers

### Runtime Dependencies
- **FFmpeg**: Video processing (bundled)
- **Bun**: JavaScript runtime for pipes (bundled)
- **Platform Libraries**: Native OCR/audio APIs
- **ONNX Runtime**: ML model inference

### Directory Structure
```
~/.screenpipe/
├── db.sqlite          # Main database
├── *.mp4              # Video chunks
├── pipes/             # Plugin configurations
├── logs/              # Application logs
└── models/            # ML model cache
```

This architecture enables Screenpipe to operate as a comprehensive digital memory system with high performance, extensibility, and privacy-first design principles.