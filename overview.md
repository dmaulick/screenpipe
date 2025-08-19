
## End‑to‑End Architecture (Multimodal)

````mermaid
flowchart LR
  subgraph CAPTURE
    A1[Screen Capture]
    A2[Audio Capture]
  end
  subgraph FILTER
    B1[Frame Change Detection]
    B2[Voice Activity Detection]
  end
  subgraph UNDERSTAND
    C1[OCR]
    C2[Speech-to-Text]
    C3[Speaker Diarization]
  end
  subgraph STORE
    D1[SQLite]
    D2[FTS5]
    D3[sqlite-vec]
  end
  subgraph INTELLIGENCE
    E1[Event Bus WebSocket]
    E2[LLM / Agents]
  end

  A1 --> B1 --> C1 --> D1
  A2 --> B2 --> C2 --> D1
  C3 --> D1
  D1 --> D2
  D1 --> D3
  D2 --> E2
  D3 --> E2
  D1 --> E1
````

**Library anchors**
- **Screen:** `cidre` (macOS Vision), `windows` (WinRT OCR), `xcap` (cross‑platform)
- **Audio:** `cpal`, `symphonia`, `rubato`
- **Filter:** `image-compare` (SSIM+hist), `webrtc-vad`, Silero via `onnxruntime`
- **Understand:** Apple/Win OCR, `tesseract-rs` (fallback), `whisper-rs` or `candle‑whisper`, `onnxruntime` + PyAnnote/WeSpeaker
- **Store:** `sqlx` + SQLite (FTS5), `sqlite-vec`
- **Events/API:** `axum`, `tower-http`
- **LLM/Embeddings:** `candle`, `tokenizers`

---

## Unified Timeline (fusion on time ±δ)

````mermaid
sequenceDiagram
  participant Mon as Screen Task
  participant Aud as Audio Task
  participant OCR as OCR
  participant STT as STT
  participant Spk as Diarization
  participant DB as SQLite
  participant EV as Events
  participant LLM as LLM/Agents

  Mon->>Mon: Capture frame
  Mon->>Mon: Change detect skip if small
  Mon->>OCR: Send crop/window for OCR
  OCR-->>Mon: Text + boxes

  Aud->>Aud: Collect chunk with overlap
  Aud->>Aud: VAD gate speech?
  Aud->>STT: Transcribe chunk
  STT-->>Aud: Transcript + timings
  Aud->>Spk: Extract voice embedding
  Spk-->>Aud: Speaker ID

  Mon->>DB: Insert frames + OCR
  Aud->>DB: Insert audio + transcript
  Spk->>DB: Upsert speakers
  DB-->>EV: Emit events
  DB-->>LLM: Retrieve fused scene
  LLM-->>EV: Insights/actions
````

---

## Data‑Flow (operator’s view)

````mermaid
flowchart TD
    A[Device Detection] --> B[Capture]
    B --> C{Speech/Change?}
    C -- No --> B
    C -- Yes --> D[Preprocess / Resample]
    D --> E[Segmentation]
    E --> F[Embeddings]
    F --> G[Speaker ID]
    D --> H[STT]
    H --> I[Overlap Cleanup]
    I --> J[SQLite + FTS5 + sqlite-vec]
    J --> K[WebSocket Events]
    J --> L[Intelligence / LLM]
````

---

# Screenpipe Audio Recording Pipeline: Complete Technical Deep Dive

> *This section is the authoritative reference for the audio path.*

## Architecture Overview

Screenpipe's audio recording system is a **sophisticated multi‑stage pipeline** that captures audio from multiple devices simultaneously, processes it through advanced speech recognition, performs speaker identification, and extracts intelligence through AI analysis.

```
Device Detection → Audio Capture → Voice Activity Detection → Speech Segmentation → Speech‑to‑Text → Speaker Identification → Database Storage → Intelligence Extraction
```

## Stage 1: Audio Manager Initialization & Device Management

### **Entry Point**: `screenpipe-audio/src/audio_manager/manager.rs:64`
```rust
pub async fn new(
    options: AudioManagerOptions, 
    db: Arc<DatabaseManager>
) -> Result<AudioManager>
```

### **Core Architecture**:
```rust
pub struct AudioManager {
    options: Arc<RwLock<AudioManagerOptions>>,
    device_manager: Arc<DeviceManager>,
    segmentation_manager: Arc<SegmentationManager>,
    status: Arc<RwLock<AudioManagerStatus>>,
    db: Arc<DatabaseManager>,
    vad_engine: Arc<Mutex<Box<dyn VadEngine + Send>>>,
    recording_handles: Arc<RecordingHandlesMap>,
    recording_sender: Arc<crossbeam::channel::Sender<AudioInput>>,
    recording_receiver: Arc<crossbeam::channel::Receiver<AudioInput>>,
    transcription_sender: Arc<crossbeam::channel::Sender<TranscriptionResult>>,
    transcription_receiver: Arc<crossbeam::channel::Receiver<TranscriptionResult>>,
    // Task handles for monitoring
    transcription_receiver_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
    recording_receiver_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
    stt_model_path: PathBuf,
}
```

### **Initialization Process**:

1. **Device Manager Setup**:
```rust
let device_manager = DeviceManager::new().await?;
```

2. **Segmentation Manager** (Speaker Identification):
```rust
let segmentation_manager = Arc::new(SegmentationManager::new().await?);
```

3. **Voice Activity Detection Engine**:
```rust
let vad_engine: Arc<Mutex<Box<dyn VadEngine + Send>>> = match options.vad_engine {
    VadEngineEnum::Silero => Arc::new(Mutex::new(Box::new(SileroVad::new().await?))),
    VadEngineEnum::WebRtc => Arc::new(Mutex::new(Box::new(WebRtcVad::new()))),
};
```

4. **Producer‑Consumer Channel Setup**:
```rust
let (recording_sender, recording_receiver) = crossbeam::channel::bounded(1000);
let (transcription_sender, transcription_receiver) = crossbeam::channel::bounded(1000);
```

5. **Whisper Model Download**:
```rust
let stt_model_path = download_whisper_model(options.transcription_engine.clone())?;
whisper_rs::install_logging_hooks();
```

### **Key Libraries**:
- **crossbeam::channel**: Lock‑free bounded channels for inter‑thread communication
- **dashmap::DashMap**: Concurrent hash map for recording handles
- **tokio::sync**: Async coordination primitives (RwLock, Mutex)
- **whisper-rs**: Rust bindings for OpenAI Whisper STT models

## Stage 2: Multi‑Device Audio Capture

### **Device Detection**: `screenpipe-audio/src/core/device.rs`
```rust
#[derive(Clone, Eq, PartialEq, Hash, Serialize, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub device_type: DeviceType, // Input or Output
}

pub enum DeviceType {
    Input,  // Microphones
    Output, // Speakers/Headphones
}
```

### **Audio Capture Process**: `screenpipe-audio/src/core/run_record_and_transcribe.rs:16`
```rust
pub async fn run_record_and_transcribe(
    audio_stream: Arc<AudioStream>,
    duration: Duration,
    whisper_sender: Arc<crossbeam::channel::Sender<AudioInput>>,
    is_running: Arc<AtomicBool>,
) -> Result<()>
```

### **Continuous Recording Loop**:

1. **Stream Subscription**:
```rust
let mut receiver = audio_stream.subscribe().await;
let device_name = audio_stream.device.to_string();
```

2. **Audio Buffer Management**:
```rust
const OVERLAP_SECONDS: usize = 2;
let mut collected_audio = Vec::new();
let sample_rate = audio_stream.device_config.sample_rate().0 as usize;
let audio_samples_len = sample_rate * duration.as_secs() as usize;
let overlap_samples = OVERLAP_SECONDS * sample_rate;
let max_samples = audio_samples_len + overlap_samples;
```

3. **Overlapping Segment Collection**:
```rust
while collected_audio.len() < max_samples && is_running.load(Ordering::Relaxed) {
    match receiver.recv().await {
        Ok(chunk) => {
            collected_audio.extend(chunk);
            update_device_capture_time(&device_name);
        }
        Err(e) => return Err(anyhow!("Audio stream error: {}", e)),
    }
}
```

4. **Segment Transmission with Overlap**:
```rust
match whisper_sender.try_send(AudioInput {
    data: Arc::new(collected_audio.clone()),
    device: audio_stream.device.clone(),
    sample_rate: audio_stream.device_config.sample_rate().0,
    channels: audio_stream.device_config.channels(),
}) {
    Ok(_) => {
        if collected_audio.len() > overlap_samples {
            // Keep overlap for next segment
            collected_audio = collected_audio.split_off(
                collected_audio.len() - overlap_samples
            );
        }
    }
    Err(e) if e.is_full() => {
        warn!("whisper channel full, dropping audio segment");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
```

### **Platform‑Specific Capture**:
- **CPAL Library**: Cross‑platform audio I/O
- **Multi‑Device Support**: Simultaneous input/output capture
- **Sample Rate Handling**: Automatic resampling to 16kHz standard

### **Key Libraries**:
- **cpal**: Cross‑platform audio library (forked for Screenpipe)
- **std::sync::atomic**: Thread‑safe status flags
- **tokio::sync**: Async communication primitives

## Stage 3: Voice Activity Detection (VAD)

### **VAD Engine Architecture**: `screenpipe-audio/src/vad/mod.rs:37`
```rust
pub trait VadEngine: Send {
    fn is_voice_segment(&mut self, audio_chunk: &[f32]) -> anyhow::Result<bool>;
    fn set_sensitivity(&mut self, sensitivity: VadSensitivity);
    fn audio_type(&mut self, audio_chunk: &[f32]) -> anyhow::Result<VadStatus>;
    fn get_min_speech_ratio(&self) -> f32;
}

#[derive(Clone, Copy, Debug, Default)]
pub enum VadSensitivity {
    Low,     // 1% of frames must be speech
    #[default]
    Medium,  // 5% of frames must be speech
    High,    // 20% of frames must be speech
}
```

### **Dual VAD Engine Support**:

#### **1. WebRTC VAD** (`screenpipe-audio/src/vad/webrtc.rs`):
- **Library**: `vad-rs` (WebRTC Voice Activity Detection)
- **Characteristics**: Fast, lightweight, rule‑based
- **Use Case**: Real‑time processing with minimal latency

#### **2. Silero VAD** (`screenpipe-audio/src/vad/silero.rs`):
- **Library**: Deep learning‑based VAD model
- **Characteristics**: Higher accuracy, ML‑based detection
- **Use Case**: Improved accuracy for complex audio scenarios

### **VAD Processing Logic**:
```rust
const FRAME_HISTORY: usize = 10;
const SPEECH_THRESHOLD: f32 = 0.5;
const SILENCE_THRESHOLD: f32 = 0.35;
const SPEECH_FRAME_THRESHOLD: usize = 3; // Minimum speech frames
```

### **Speech Quality Filtering**:
```rust
// In prepare_segments function
if !speech_ratio_ok {
    return Ok(()); // Skip processing if insufficient speech
}
```

### **Libraries**:
- **vad-rs**: WebRTC VAD implementation
- **ort**: ONNX Runtime for Silero VAD model inference
- **lazy_static**: Global VAD model management

## Stage 4: Audio Preprocessing & Resampling

### **Preprocessing Pipeline**: `screenpipe-audio/src/transcription/stt.rs:105`
```rust
pub async fn process_audio_input(
    audio: AudioInput,
    vad_engine: Arc<Mutex<Box<dyn VadEngine + Send>>>,
    segmentation_model_path: PathBuf,
    embedding_manager: EmbeddingManager,
    embedding_extractor: Arc<StdMutex<EmbeddingExtractor>>,
    // ... other parameters
) -> Result<()>
```

### **Sample Rate Normalization**:
```rust
pub const SAMPLE_RATE: u32 = 16000; // Standard for STT models

let audio_data = if audio.sample_rate != SAMPLE_RATE {
    resample(audio.data.as_ref(), audio.sample_rate, SAMPLE_RATE)?
} else {
    audio.data.as_ref().to_vec()
};
```

### **Audio Segmentation Process**:
```rust
let (mut segments, speech_ratio_ok) = prepare_segments(
    &audio_data,
    vad_engine,
    &segmentation_model_path,
    embedding_manager,
    embedding_extractor,
    &audio.device.to_string(),
).await?;
```

### **File Persistence**:
```rust
let new_file_path = get_new_file_path(&audio.device.to_string(), output_path);
write_audio_to_file(
    &audio.data.to_vec(),
    audio.sample_rate,
    &PathBuf::from(&new_file_path),
    false,
)?;
```

### **Libraries**:
- **Audio Resampling**: Custom FFT‑based resampling algorithms
- **FFmpeg Integration**: File I/O and format conversion

## Stage 5: Speech‑to‑Text Processing

### **Multi‑Engine STT Architecture**: `screenpipe-audio/src/core/engine.rs:4`
```rust
#[derive(Clone, Debug, PartialEq, Default)]
pub enum AudioTranscriptionEngine {
    Deepgram,                    // Cloud-based API
    WhisperTiny,                // Lightweight local model
    WhisperTinyQuantized,       // Compressed tiny model
    #[default]
    WhisperLargeV3Turbo,        // Fast large model
    WhisperLargeV3TurboQuantized, // Compressed turbo model
    WhisperLargeV3,            // Full accuracy large model
    WhisperLargeV3Quantized,   // Compressed large model
}
```

### **STT Processing Function**: `screenpipe-audio/src/transcription/stt.rs:57`
```rust
pub async fn stt(
    audio: &[f32],
    sample_rate: u32,
    device: &str,
    audio_transcription_engine: Arc<AudioTranscriptionEngine>,
    deepgram_api_key: Option<String>,
    languages: Vec<Language>,
    whisper_context: Arc<WhisperContext>,
) -> Result<String>
```

### **Engine Selection Logic**:
```rust
let transcription: Result<String> = 
    if audio_transcription_engine == AudioTranscriptionEngine::Deepgram.into() {
        match transcribe_with_deepgram(&api_key, audio, device, sample_rate, languages.clone()).await {
            Ok(transcription) => Ok(transcription),
            Err(e) => {
                error!("Deepgram failed, falling back to Whisper: {:?}", e);
                process_with_whisper(audio, languages.clone(), whisper_context).await
            }
        }
    } else {
        process_with_whisper(audio, languages, whisper_context).await
    };
```

### **Whisper Processing Details**:

#### **Model Management**:
- **Automatic Download**: Models cached locally on first use
- **Context Sharing**: Single `WhisperContext` shared across threads
- **Memory Optimization**: Efficient model loading and inference

#### **Multi‑Language Support**:
- **Language Detection**: Automatic language identification
- **13+ Languages**: English, Spanish, French, German, Italian, Portuguese, Russian, Chinese, Korean, Japanese, Ukrainian, Thai, Arabic

### **Cloud Integration (Deepgram)**:
```rust
// screenpipe-audio/src/transcription/deepgram/batch.rs
pub async fn transcribe_with_deepgram(
    api_key: &str,
    audio: &[f32], 
    device: &str,
    sample_rate: u32,
    languages: Vec<Language>,
) -> Result<String>
```

### **Libraries**:
- **whisper-rs**: Rust bindings for OpenAI Whisper
- **deepgram**: HTTP client for Deepgram API
- **hf-hub**: HuggingFace model downloads
- **reqwest**: HTTP client for API calls

## Stage 6: Speaker Identification & Diarization

### **Speaker Processing Architecture**: `screenpipe-audio/src/segmentation/segmentation_manager.rs`
```rust
pub struct SegmentationManager {
    pub embedding_manager: EmbeddingManager,
    pub embedding_extractor: Arc<StdMutex<EmbeddingExtractor>>,
    pub segmentation_model_path: PathBuf,
}
```

### **PyAnnote Integration**:
```rust
pub async fn new() -> Result<Self> {
    let embedding_model_path = get_or_download_model(PyannoteModel::Embedding).await?;
    let segmentation_model_path = get_or_download_model(PyannoteModel::Segmentation).await?;
    
    let embedding_extractor = Arc::new(StdMutex::new(
        EmbeddingExtractor::new(embedding_model_path.to_str())?
    ));
    
    let embedding_manager = EmbeddingManager::new(usize::MAX);
    // ...
}
```

### **Speaker Embedding Generation**: `screenpipe-audio/src/speaker/embedding.rs:16`
```rust
impl EmbeddingExtractor {
    pub fn compute(&mut self, samples: &[f32]) -> Result<impl Iterator<Item = f32>> {
        // 1. Extract filter bank features
        let features: Array2<f32> = knf_rs::compute_fbank(samples)?;
        let features = features.insert_axis(ndarray::Axis(0)); // Add batch dimension
        
        // 2. Run ONNX inference
        let inputs = ort::inputs! ["feats" => features.view()]?;
        let ort_outs = self.session.run(inputs)?;
        
        // 3. Extract embeddings
        let ort_out = ort_outs
            .get("embs")?
            .try_extract_tensor::<f32>()?;
            
        let embeddings: Vec<f32> = ort_out.iter().copied().collect();
        Ok(embeddings.into_iter())
    }
}
```

### **Speaker Clustering Process**:

1. **Voice Embedding Extraction**: WeSpeaker model generates 512‑dimensional embeddings
2. **Similarity Clustering**: Cosine similarity‑based speaker grouping
3. **Dynamic Speaker Assignment**: New speakers added automatically
4. **Persistent Speaker Profiles**: Database storage of speaker identities

### **Speaker Segmentation Pipeline**:
```rust
// Process each speech segment for speaker identification
while let Some(segment) = segments.recv().await {
    let embedding = embedding_extractor.compute(&segment.audio_data)?;
    let speaker_id = embedding_manager.identify_or_create_speaker(embedding)?;
    
    segment.speaker_id = Some(speaker_id);
    // Continue to transcription...
}
```

### **Libraries**:
- **ort**: ONNX Runtime for PyAnnote models
- **ndarray**: N‑dimensional arrays for ML processing
- **knf-rs**: Filter bank feature extraction
- **PyAnnote Models**: 
  - `segmentation-3.0.onnx`: Speaker segmentation
  - `wespeaker_en_voxceleb_CAM++.onnx`: Speaker embeddings

## Stage 7: Database Storage & Indexing

### **Transcription Storage**: Database insertion via `screenpipe-db`
```rust
pub async fn insert_audio_transcription(
    &self,
    audio_chunk_id: i64,
    transcription: &str,
    offset_index: i64,
    transcription_engine: &str,
    device: &AudioDevice,
    speaker_id: Option<i64>,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<i64, sqlx::Error>
```

### **Database Schema**:

#### **Audio Tables**:
```sql
-- Audio file metadata
audio_chunks (id, file_path, timestamp)

-- Transcription results with speaker info
audio_transcriptions (
    id, audio_chunk_id, transcription, 
    offset_index, transcription_engine,
    device_name, device_type,
    speaker_id, start_time, end_time
)

-- Speaker identity clustering
speakers (
    id, name, created_at, updated_at,
    embedding, metadata
)
```

#### **Full‑Text Search Integration**:
```sql
-- FTS5 virtual table for audio search
CREATE VIRTUAL TABLE audio_transcriptions_fts USING fts5(
    transcription, 
    content='audio_transcriptions'
);

-- Automatic FTS index updates
INSERT INTO audio_transcriptions_fts(rowid, transcription) 
VALUES (?, ?);
```

### **Overlap Handling & Deduplication**: `screenpipe-audio/src/transcription/handle_new_transcript.rs:33`
```rust
let mut current_transcript: Option<String> = transcription.transcription.clone();
let mut processed_previous: Option<String> = None;

if let Some((previous, current)) = transcription.cleanup_overlap(previous_transcript.clone()) {
    if !previous.is_empty() && !current.is_empty() {
        if previous != previous_transcript {
            processed_previous = Some(previous);
        }
        if current_transcript.is_some() && current != current_transcript.clone().unwrap_or_default() {
            current_transcript = Some(current);
        }
    }
}
```

### **Libraries**:
- **sqlx**: Type‑safe database operations
- **SQLite FTS5**: Full‑text search indexing
- **crossbeam::channel**: Producer‑consumer transcription handling

## Stage 8: Real‑Time Processing & Intelligence Extraction

### **Channel‑Based Pipeline Architecture**:
```rust
// Recording pipeline
AudioCapture → AudioInput Channel → STT Processing → TranscriptionResult Channel → Database

// Concurrent processing stages
let (recording_sender, recording_receiver) = crossbeam::channel::bounded(1000);
let (transcription_sender, transcription_receiver) = crossbeam::channel::bounded(1000);
```

### **Transcription Handler**: `screenpipe-audio/src/transcription/handle_new_transcript.rs:9`
```rust
pub async fn handle_new_transcript(
    db: Arc<DatabaseManager>,
    transcription_receiver: Arc<crossbeam::channel::Receiver<TranscriptionResult>>,
    transcription_engine: Arc<AudioTranscriptionEngine>,
) {
    let mut previous_transcript = "".to_string();
    let mut previous_transcript_id: Option<i64> = None;
    
    while let Ok(mut transcription) = transcription_receiver.recv() {
        // Process overlap cleanup
        // Insert into database
        // Update previous state
    }
}
```

### **Real‑Time Event Broadcasting**:
```rust
// Via screenpipe-events system
let event = ScreenpipeEvent::AudioTranscription {
    transcription,
    speaker_id,
    confidence_score,
    device_name,
};
send_event(event).await;
```

### **WebSocket Streaming**:
- Real‑time transcription results to connected clients
- Speaker identification updates
- Audio device status changes
- Confidence scores and metadata

## Performance Optimizations

### **Memory Management**:
1. **Arc‑based Sharing**: Shared ownership of large audio buffers
2. **Channel Buffering**: 1000‑item bounded channels prevent memory bloat
3. **Overlap Management**: Efficient buffer reuse for segment continuity
4. **Model Caching**: Single model instances shared across threads

### **Concurrency Optimizations**:
1. **Lock‑Free Channels**: `crossbeam::channel` for inter‑thread communication
2. **Per‑Device Tasks**: Independent processing per audio device
3. **Producer‑Consumer**: Parallel capture and processing pipelines
4. **Async/Await**: Non‑blocking I/O throughout the pipeline

### **Audio Processing Efficiency**:
1. **Smart VAD**: Skip processing of non‑speech segments
2. **Overlap Strategy**: 2‑second overlap prevents word boundary cuts
3. **Sample Rate Optimization**: Single resampling step to 16kHz
4. **Quantized Models**: Reduced memory usage with minimal accuracy loss

### **Database Performance**:
1. **Prepared Statements**: Compiled SQL queries for repeated operations
2. **Batch Insertions**: Transaction‑based bulk operations
3. **FTS5 Indexing**: Optimized full‑text search
4. **Connection Pooling**: Efficient database connection reuse

## Intelligence Features

### **Context‑Aware Processing**:
1. **Device Metadata**: Source device identification (microphone vs speakers)
2. **Temporal Continuity**: Overlap handling for seamless transcription
3. **Multi‑Language Support**: Automatic language detection and switching
4. **Speaker Persistence**: Long‑term speaker identity maintenance

### **AI Integration**:
1. **Local STT Models**: Privacy‑preserving speech recognition
2. **Speaker Embeddings**: Neural network‑based voice fingerprinting
3. **Fallback Strategies**: Cloud API fallback for improved accuracy
4. **Confidence Scoring**: Quality metrics for transcription reliability

### **Semantic Analysis**:
1. **Content Classification**: Meeting detection, conversation analysis
2. **Keyword Extraction**: Important topic identification
3. **Sentiment Analysis**: Emotional context detection
4. **Intent Recognition**: Command and query identification

## Complete Audio Data Flow Summary

````mermaid
flowchart TD
    A[Audio Device Detection] --> B[Multi-Device Capture]
    B --> C[Voice Activity Detection]
    C -->|Speech| D[Preprocess / 16kHz Resample]
    C -->|Silence| B
    D --> E[Speaker Segmentation]
    E --> F[Speaker Embeddings]
    F --> G[Speaker Identification]
    D --> H[STT]
    H --> I[Overlap Cleanup]
    I --> J[SQLite + FTS5]
    J --> K[WebSocket Events]
    J --> L[Intelligence]
```

---

# Core Libraries Analysis: Current vs Best‑in‑Class Alternatives (Summary)

> *For full internal tables and notes, see the original analysis; key conclusions preserved here.*

## Screen Recording Pipeline Libraries
- **macOS (cidre fork):** Best access to Apple Vision OCR. Keep; track upstream.
- **Windows (windows crate):** Native OCR via WinRT. Keep.
- **Cross‑platform capture (xcap):** Solid unified API. Keep.
- **OCR fallback (tesseract‑rs):** Works everywhere; consider PaddleOCR for accuracy.
- **Image ops (`image`) + change detect (`image‑compare`):** Keep; good perf/maintenance.

## Audio Pipeline Libraries
- **Audio I/O (`cpal` fork):** Re‑evaluate fork; prefer upstream if possible.
- **Decode/Resample (`symphonia` + `rubato`):** Keep.
- **STT (`whisper‑rs`, Deepgram fallback):** Keep; consider `candle‑whisper` integration.
- **VAD (WebRTC + Silero/ORT):** Keep dual strategy.
- **Diarization (PyAnnote/WeSpeaker via ORT):** Keep; move ORT to stable.

## AI/ML
- **Candle:** Move to crates.io release for stability.
- **hf‑hub (fork):** Keep for mirror support.
- **tokenizers:** Keep.

## DB & Concurrency
- **SQLx + SQLite (FTS5) + sqlite‑vec:** Keep; plan for external vector DB at scale.
- **Axum + Tokio + Crossbeam + DashMap:** Keep.

## Recommended Migration Steps
1. **Stability:** Candle → stable; ORT → stable; reduce forks where feasible.
2. **Perf:** Evaluate `candle‑whisper`; consider PaddleOCR; tune SQLite (WAL, cache).
3. **Scale:** Optional vector DB (Qdrant/Faiss) when corpus grows.

---

## Library Map (quick reference)

| Stage | Library | Why |
|---|---|---|
| Screen capture | `cidre`, `windows`, `xcap` | Native APIs + cross‑plat fallback |
| Audio capture | `cpal` | Low‑latency, multi‑device |
| Change detect | `image-compare` | SSIM + histogram practicality |
| VAD | `webrtc-vad`, Silero via `onnxruntime` | Speed + accuracy combo |
| OCR | Apple Vision / Win OCR / `tesseract-rs` | Best native speed; portable fallback |
| STT | `whisper-rs`, Deepgram | Local default; cloud fallback |
| Diarization | `onnxruntime`, `knf-rs` | Robust voice embeddings |
| DB & Index | `sqlx`, SQLite (FTS5), `sqlite-vec` | Local, fast, simple |
| API/Events | `axum`, `tower-http` | Realtime WS + HTTP |
| LLM | `candle`, `tokenizers` | Local inference + embeddings |

---

**Notes**
- Mermaid diagrams in this file use conservative syntax (no HTML, emojis, or unsupported glyphs) to maximize renderer compatibility.
- If any renderer issues persist, verify your Markdown viewer supports Mermaid 10+.