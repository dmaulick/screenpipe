Complete Screen Recording Pipeline: Capture to Intelligence Extraction

  Architecture Overview

  Screenpipe's screen recording system operates through a multi-stage pipeline that transforms raw screen captures into searchable, intelligent data. Here's the complete
  technical breakdown:

  Monitor Detection → Screenshot Capture → Change Detection → OCR Processing → Database Storage → Intelligence Extraction

  Stage 1: Monitor Detection & Setup

  Library: screenpipe-vision/src/monitor.rs

  // screenpipe-server/src/core.rs:46
  vision_handle.spawn(async move {
      loop {
          match record_video(
              db_manager_video.clone(),
              fps,
              ocr_engine.clone(),
              monitor_id,
              // ... other parameters
          ).await

  Process:
  1. Monitor Enumeration: Uses platform-specific APIs to detect available monitors
  2. Per-Monitor Tasks: Spawns independent Tokio tasks for each monitor
  3. Recovery Logic: Wraps each monitor task in infinite loops with error recovery

  Key Libraries:
  - tokio: Async task management and spawning
  - crossbeam::queue::ArrayQueue: Lock-free queues for frame processing

  Stage 2: Screenshot Capture

  Core Function: screenpipe-vision/src/utils.rs:75

  pub async fn capture_screenshot(
      monitor: &SafeMonitor,
      window_filters: &WindowFilters,
      capture_unfocused_windows: bool,
  ) -> Result<(DynamicImage, Vec<CapturedWindow>, u64, Duration), anyhow::Error>

  Process Flow:
  1. Monitor Image Capture: monitor.capture_image().await
  2. Window Enumeration: capture_all_visible_windows() for individual window capture
  3. Hash Calculation: calculate_hash(&image) using std::hash::DefaultHasher
  4. Performance Timing: Measures capture duration for monitoring

  Libraries Used:
  - Platform-Specific:
    - macOS: Core Graphics framework via Rust bindings
    - Windows: Windows Graphics Capture API
    - Linux: X11/Wayland capture APIs
  - image: DynamicImage for cross-platform image handling

  Stage 3: Intelligent Change Detection

  Core Algorithm: screenpipe-vision/src/utils.rs:105

  pub async fn compare_with_previous_image(
      previous_image: Option<&DynamicImage>,
      current_image: &DynamicImage,
      // ...
  ) -> anyhow::Result<f64>

  Change Detection Pipeline:

  1. Histogram Comparison:
  // screenpipe-vision/src/utils.rs:62
  let histogram_diff = image_compare::gray_similarity_histogram(
      Metric::Hellinger,
      &image_one,
      &image_two
  )?;

  2. Structural Similarity (SSIM):
  // screenpipe-vision/src/utils.rs:69
  let result = image_compare::gray_similarity_structure(
      &Algorithm::MSSIMSimple,
      &image_one,
      &image_two
  )?;

  3. Combined Score:
  current_average = (histogram_diff + ssim_diff) / 2.0;

  4. Frame Selection Logic:
  // screenpipe-vision/src/core.rs:258
  if current_average < 0.006 {
      // Skip frame - too little change
      return true;
  }

  Libraries:
  - image-compare: Hellinger distance and SSIM algorithms
  - image: Grayscale conversion and pixel access

  Stage 4: OCR Processing Engine

  Multi-Engine Architecture: screenpipe-vision/src/core.rs:317

  pub async fn process_ocr_task(
      ocr_task_data: OcrTaskData,
      ocr_engine: &OcrEngine,
      languages: Vec<Language>,
  ) -> Result<(), ContinuousCaptureError>

  OCR Engine Selection:
  // screenpipe-vision/src/utils.rs:15
  pub enum OcrEngine {
      Unstructured,      // Cloud-based
      Tesseract,         // Cross-platform
      WindowsNative,     // Windows OCR API
      AppleNative,       // Apple Vision framework
      Custom(CustomOcrConfig),
  }

  Platform-Specific OCR Implementations:

  Apple Vision Framework (screenpipe-vision/src/apple.rs:72):

  pub fn perform_ocr_apple(
      image: &DynamicImage,
      languages: &[Language],
  ) -> (String, String, Option<f64>)

  Process:
  1. Image Conversion: image.grayscale().to_luma8() - Convert to grayscale
  2. Pixel Buffer Creation:

  let pixel_buf = PixelBuf::create_with_bytes_in(
      width, height,
      PixelFormat::ONE_COMPONENT_8,
      raw_data.as_ptr() as *mut c_void,
      // ...
  )?;
  3. Vision Framework Processing:
  let handler = ImageRequestHandler::with_cv_pixel_buf(&pixel_buf, None)?;
  let mut request = RecognizeTextRequest::new();
  request.set_recognition_langs(&languages_array);
  let result = handler.perform(&requests);

  Libraries:
  - cidre: Rust bindings for Apple's Vision framework
  - objc: Objective-C runtime access for memory management

  Windows OCR (screenpipe-vision/src/microsoft.rs):

  - Uses Windows Runtime APIs for native OCR processing
  - windows crate with Media_Ocr and Graphics_Imaging features

  Tesseract OCR (screenpipe-vision/src/tesseract.rs):

  - tesseract-rs: Rust bindings for Tesseract C++ library
  - Cross-platform fallback with extensive language support

  OCR Result Processing:

  // screenpipe-vision/src/core.rs:345-390
  for window_image in window_images {
      let (text, json, confidence) = match ocr_engine {
          OcrEngine::Tesseract => perform_ocr_tesseract(&window_image.image, languages),
          OcrEngine::AppleNative => perform_ocr_apple(&window_image.image, languages),
          OcrEngine::WindowsNative => perform_ocr_windows(&window_image.image, languages),
          // ... other engines
      };

      window_ocr_results.push(WindowOcrResult {
          image: window_image.image,
          window_name: window_image.window_name,
          app_name: window_image.app_name,
          text,
          text_json: json,
          focused: window_image.focused,
          confidence,
          browser_url: detected_url,
      });
  }

  Stage 5: Database Storage & Indexing

  Database Architecture: screenpipe-db/src/db.rs

  pub async fn insert_frame(&self, frame: FrameData) -> Result<i64, sqlx::Error>

  Storage Process:

  1. Frame Metadata Storage:
  INSERT INTO frames (
      timestamp, file_path, offset_index, app_name, window_name,
      monitor_id, frame_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)

  2. OCR Text Storage with FTS5:
  INSERT INTO ocr_text (frame_id, text, confidence, language)
  VALUES (?, ?, ?, ?)

  3. Full-Text Search Index:
  INSERT INTO ocr_text_fts (rowid, text)
  SELECT id, text FROM ocr_text WHERE id = ?

  Libraries:
  - sqlx: Type-safe SQL with compile-time verification
  - SQLite: With FTS5 extension for full-text search
  - sqlite-vec: Vector embeddings for semantic search

  Stage 6: Intelligence Extraction

  Real-Time Processing Pipeline:

  1. WebSocket Broadcasting:
  // screenpipe-server/src/server.rs
  let event = ScreenpipeEvent::VisionResult {
      frame_id,
      timestamp,
      text_results: window_ocr_results,
  };
  send_event(event).await;

  2. Text Embedding Generation:
  // screenpipe-server/src/text_embeds.rs
  pub async fn generate_embedding(text: &str) -> Result<Vec<f32>>

  3. Semantic Search:
  -- Vector similarity search
  SELECT frame_id, text, embedding <-> ? as distance
  FROM text_embeddings
  ORDER BY distance ASC LIMIT 10

  AI/ML Integration (screenpipe-core/src/llm.rs):

  Local LLM Processing:
  - Candle Framework: HuggingFace's Rust ML library
  - Model Support: Llama, Phi, Mistral models for local inference
  - Hardware Acceleration: Metal (macOS), CUDA (NVIDIA), MKL (Intel)

  Context-Aware Analysis:
  pub struct ChatMessage {
      pub role: String,
      pub content: String,  // OCR text + metadata
  }

  pub async fn process_with_llm(
      messages: Vec<ChatMessage>,
      model: Arc<Llama>,
  ) -> Result<ChatResponse>

  Performance Optimizations

  Memory Management:

  1. LRU Caching: lru::LruCache<i64, (String, Instant)> for processed frames
  2. Lock-Free Queues: crossbeam::queue::ArrayQueue for inter-task communication
  3. Streaming Processing: Frames processed in chunks to limit memory usage

  Concurrency Model:

  1. Per-Monitor Tasks: Independent async tasks prevent blocking
  2. Producer-Consumer: Capture → Process → Store pipeline
  3. Error Recovery: Automatic restart on task failures

  Intelligence Features:

  1. URL Detection: Browser-specific logic to extract current URLs
  2. Window Context: App name, window title, focus state tracking
  3. Language Support: Multi-language OCR with confidence scoring
  4. PII Filtering: Optional removal of sensitive information

  Complete Data Flow Summary

  1. Monitor.capture_image()
     ↓ [Platform APIs: Core Graphics/Windows Graphics/X11]
  2. Image comparison (Histogram + SSIM)
     ↓ [image-compare library]
  3. OCR processing (Apple Vision/Windows OCR/Tesseract)
     ↓ [cidre/windows/tesseract-rs]
  4. Text extraction with bounding boxes + confidence
     ↓ [JSON serialization]
  5. Database storage (SQLite + FTS5 indexing)
     ↓ [sqlx]
  6. Real-time WebSocket broadcast
     ↓ [axum WebSocket]
  7. LLM processing for intelligence extraction
     ↓ [Candle + local models]
  8. Semantic search + embedding storage
     ↓ [sqlite-vec]

  This pipeline transforms raw pixels into searchable, intelligent data while maintaining high performance through intelligent frame skipping, efficient OCR engines, and
  optimized database operations. The system processes thousands of frames daily while extracting meaningful intelligence from screen activity.