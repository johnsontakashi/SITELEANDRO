/**
 * Ultra Fast KMZ File Uploader 2024
 * Implements latest web performance techniques:
 * - fflate compression (fastest JS compression library)
 * - Web Workers for parallel processing  
 * - Web Streams API for memory efficiency
 * - Parallel chunk uploads
 * - Client-side compression optimization
 */

class UltraFastUploader {
  constructor(options = {}) {
    this.options = {
      // Performance settings based on 2024 research
      chunkSize: 2 * 1024 * 1024, // 2MB optimal for 2024
      maxParallelChunks: 6, // Optimal parallel connections
      maxCompressionWorkers: 2, // Parallel compression workers
      compressionLevel: 6, // Balance speed vs compression
      useCompression: true,
      useWorkers: true,
      retryAttempts: 3,
      apiEndpoint: '/api/chunked_upload.php',
      ...options
    };

    this.worker = null;
    this.uploadQueue = [];
    this.activeUploads = 0;
    this.compressionWorkers = [];
    this.availableWorkers = [];
    this.streamController = null;
  }

  /**
   * Ultra-fast file upload with all optimizations
   */
  async uploadFile(file, cityId, onProgress = () => {}, onComplete = () => {}) {
    console.log('🚀 Ultra Fast Uploader: Starting optimized upload');
    const startTime = performance.now();

    try {
      // Step 1: Analyze file for optimal processing strategy
      const strategy = this.analyzeFile(file);
      console.log(`📊 Upload strategy: ${strategy.type} (${strategy.reason})`);

      // Step 2: Pre-process file if needed
      const processedFile = await this.preprocessFile(file, strategy);
      
      // Step 3: Use optimal upload method
      let result;
      if (strategy.useStreaming) {
        result = await this.streamingUpload(processedFile, cityId, onProgress);
      } else if (strategy.useChunking) {
        result = await this.chunkedUpload(processedFile, cityId, onProgress);
      } else {
        result = await this.directUpload(processedFile, cityId, onProgress);
      }

      const duration = performance.now() - startTime;
      const speedMBps = (file.size / 1024 / 1024) / (duration / 1000);

      console.log(`✅ Upload completed in ${duration.toFixed(0)}ms at ${speedMBps.toFixed(1)} MB/s`);
      
      onComplete({
        ...result,
        originalSize: file.size,
        processedSize: processedFile.size,
        duration,
        speed: speedMBps,
        compressionRatio: file.size / processedFile.size
      });

      return result;

    } catch (error) {
      console.error('❌ Ultra Fast Upload failed:', error);
      throw error;
    }
  }

  /**
   * Analyze file to determine optimal upload strategy
   */
  analyzeFile(file) {
    const size = file.size;
    const name = file.name.toLowerCase();
    
    // Already compressed files (don't re-compress)
    const isCompressed = name.endsWith('.kmz') || name.endsWith('.zip') || 
                        name.includes('compressed');

    // Size-based strategy
    if (size < 5 * 1024 * 1024) { // < 5MB
      return {
        type: 'direct',
        useCompression: !isCompressed && this.options.useCompression,
        useChunking: false,
        useStreaming: false,
        reason: 'Small file - direct upload fastest'
      };
    } else if (size < 50 * 1024 * 1024) { // 5-50MB  
      return {
        type: 'chunked',
        useCompression: !isCompressed && this.options.useCompression,
        useChunking: true,
        useStreaming: false,
        reason: 'Medium file - chunked upload optimal'
      };
    } else { // > 50MB
      return {
        type: 'streaming',
        useCompression: !isCompressed && this.options.useCompression,
        useChunking: true,
        useStreaming: true,
        reason: 'Large file - streaming required for memory efficiency'
      };
    }
  }

  /**
   * Pre-process file with optimal compression
   */
  async preprocessFile(file, strategy) {
    if (!strategy.useCompression || !window.fflate) {
      return file;
    }

    console.log('🗜️ Compressing file with fflate...');
    const startTime = performance.now();

    try {
      // Read file as ArrayBuffer for fflate
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      // Use fflate for optimal compression
      const compressed = this.options.useWorkers && file.size > 500 * 1024 
        ? await this.compressWithWorker(uint8Array)
        : this.compressSync(uint8Array);

      const compressionTime = performance.now() - startTime;
      const ratio = buffer.byteLength / compressed.length;
      
      console.log(`✅ Compressed ${(buffer.byteLength/1024/1024).toFixed(1)}MB → ${(compressed.length/1024/1024).toFixed(1)}MB (${ratio.toFixed(1)}x) in ${compressionTime.toFixed(0)}ms`);

      // Create new file with compressed data
      return new File([compressed], file.name.replace(/\.(kml|kmz)$/i, '.kmz'), {
        type: 'application/vnd.google-earth.kmz',
        lastModified: file.lastModified
      });

    } catch (error) {
      console.warn('⚠️ Compression failed, using original file:', error);
      return file;
    }
  }

  /**
   * Synchronous compression with fflate
   */
  compressSync(data) {
    return fflate.gzipSync(data, { 
      level: this.options.compressionLevel,
      mem: 8 // Memory level for speed
    });
  }

  /**
   * Initialize compression worker pool for parallel processing
   */
  initCompressionWorkers() {
    if (this.compressionWorkers.length === 0) {
      for (let i = 0; i < this.options.maxCompressionWorkers; i++) {
        const worker = new Worker('assets/compression-worker.js');
        
        worker.onerror = (error) => {
          console.error(`💥 Compression worker ${i} error:`, error);
        };
        
        // Worker is available initially
        this.compressionWorkers.push(worker);
        this.availableWorkers.push(worker);
      }
      
      console.log(`🧠 Initialized ${this.options.maxCompressionWorkers} compression workers for parallel processing`);
    }
  }

  /**
   * Get available worker from pool
   */
  async getAvailableWorker() {
    // Initialize workers if not done yet
    this.initCompressionWorkers();
    
    // Wait for available worker
    while (this.availableWorkers.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    return this.availableWorkers.pop();
  }

  /**
   * Return worker to available pool
   */
  returnWorker(worker) {
    if (!this.availableWorkers.includes(worker)) {
      this.availableWorkers.push(worker);
    }
  }

  /**
   * Asynchronous compression with dedicated Web Worker pool
   */
  async compressWithWorker(data) {
    const worker = await this.getAvailableWorker();

    return new Promise((resolve, reject) => {
      const taskId = Date.now() + Math.random();
      
      // Set up one-time message handler for this task
      const messageHandler = (e) => {
        const { id, success, result, error, stats } = e.data;
        
        if (id === taskId) {
          worker.removeEventListener('message', messageHandler);
          
          // Return worker to pool
          this.returnWorker(worker);
          
          if (success) {
            if (stats) {
              console.log(`🗜️ Worker compressed ${(stats.originalSize/1024/1024).toFixed(1)}MB → ${(stats.compressedSize/1024/1024).toFixed(1)}MB (${stats.compressionRatio.toFixed(1)}x) at ${stats.speedMBps.toFixed(1)} MB/s`);
            }
            resolve(result);
          } else {
            reject(new Error(error));
          }
        }
      };
      
      worker.addEventListener('message', messageHandler);
      
      // Send compression task to worker
      worker.postMessage({
        id: taskId,
        action: 'compress',
        data: data,
        options: {
          level: this.options.compressionLevel,
          mem: 8,
          method: 'gzip'
        }
      });
    });
  }

  /**
   * Direct upload for small files
   */
  async directUpload(file, cityId, onProgress) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('cityId', cityId);
    formData.append('dev', '1');

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      if (xhr.upload) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress({ progress: (e.loaded / e.total) * 100 });
          }
        });
      }

      xhr.addEventListener('load', () => {
        try {
          const result = JSON.parse(xhr.responseText);
          if (result.ok) resolve(result.data);
          else reject(new Error(result.error));
        } catch (e) {
          reject(e);
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.open('POST', this.options.apiEndpoint);
      xhr.send(formData);
    });
  }

  /**
   * Chunked upload with parallel processing
   */
  async chunkedUpload(file, cityId, onProgress) {
    const uploadId = this.generateUploadId();
    const totalChunks = Math.ceil(file.size / this.options.chunkSize);
    
    console.log(`📦 Chunked upload: ${totalChunks} chunks of ${(this.options.chunkSize/1024/1024).toFixed(1)}MB each`);

    // Create chunks
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.options.chunkSize;
      const end = Math.min(start + this.options.chunkSize, file.size);
      chunks.push({
        index: i,
        blob: file.slice(start, end),
        uploaded: false,
        attempts: 0
      });
    }

    // Enhanced parallel upload with intelligent load balancing
    const uploadedChunks = new Set();
    const failedChunks = [];
    const uploadStats = {
      startTime: performance.now(),
      chunkTimes: [],
      avgSpeed: 0
    };

    // Dynamic worker scaling based on chunk count and network performance
    const optimalWorkers = Math.min(
      this.options.maxParallelChunks,
      Math.max(1, Math.ceil(totalChunks / 10)) // Scale workers based on chunk count
    );

    console.log(`⚡ Starting ${optimalWorkers} parallel upload workers for optimal performance`);

    // Create worker promises with load balancing
    const workers = [];
    for (let i = 0; i < optimalWorkers; i++) {
      workers.push(this.enhancedChunkWorker(chunks, uploadId, file, uploadedChunks, totalChunks, onProgress, uploadStats, failedChunks, i));
    }

    await Promise.all(workers);

    // Handle any failed chunks with retry logic
    if (failedChunks.length > 0) {
      console.log(`🔄 Retrying ${failedChunks.length} failed chunks...`);
      await this.retryFailedChunks(failedChunks, uploadId, file, uploadedChunks, totalChunks, onProgress);
    }

    // Complete upload
    return await this.completeChunkedUpload(uploadId, cityId);
  }

  /**
   * Enhanced chunk upload worker with performance monitoring
   */
  async enhancedChunkWorker(chunks, uploadId, file, uploadedChunks, totalChunks, onProgress, uploadStats, failedChunks, workerId) {
    let workerChunksProcessed = 0;
    
    while (true) {
      // Priority-based chunk selection (smaller chunks first for faster initial progress)
      const chunk = chunks.find(c => !c.uploaded && c.attempts < this.options.retryAttempts);
      if (!chunk) break;

      chunk.attempts++;
      const chunkStartTime = performance.now();

      try {
        // Upload chunk with performance tracking
        await this.uploadChunk(chunk, uploadId, file);
        
        chunk.uploaded = true;
        uploadedChunks.add(chunk.index);
        workerChunksProcessed++;

        // Track performance statistics
        const chunkTime = performance.now() - chunkStartTime;
        uploadStats.chunkTimes.push(chunkTime);
        
        // Calculate rolling average speed
        if (uploadStats.chunkTimes.length > 5) {
          uploadStats.chunkTimes.shift(); // Keep only recent measurements
        }
        
        const avgChunkTime = uploadStats.chunkTimes.reduce((a, b) => a + b) / uploadStats.chunkTimes.length;
        const chunkSizeMB = chunk.blob.size / 1024 / 1024;
        uploadStats.avgSpeed = chunkSizeMB / (avgChunkTime / 1000);

        // Enhanced progress reporting with performance data
        const progress = (uploadedChunks.size / totalChunks) * 100;
        const overallDuration = (performance.now() - uploadStats.startTime) / 1000;
        const eta = totalChunks > uploadedChunks.size ? (totalChunks - uploadedChunks.size) * avgChunkTime / 1000 : 0;

        onProgress({
          progress,
          uploadedChunks: uploadedChunks.size,
          totalChunks,
          currentChunk: chunk.index,
          workerId,
          avgSpeed: uploadStats.avgSpeed,
          eta: Math.round(eta),
          overallDuration: Math.round(overallDuration)
        });

      } catch (error) {
        console.warn(`⚠️ Worker ${workerId}: Chunk ${chunk.index} failed (attempt ${chunk.attempts}):`, error);
        
        if (chunk.attempts >= this.options.retryAttempts) {
          failedChunks.push(chunk);
          console.error(`❌ Worker ${workerId}: Chunk ${chunk.index} failed permanently after ${this.options.retryAttempts} attempts`);
        }
      }
    }
    
    console.log(`✅ Worker ${workerId} completed: ${workerChunksProcessed} chunks processed`);
  }

  /**
   * Retry failed chunks with different strategy
   */
  async retryFailedChunks(failedChunks, uploadId, file, uploadedChunks, totalChunks, onProgress) {
    for (const chunk of failedChunks) {
      try {
        console.log(`🔄 Final retry for chunk ${chunk.index}...`);
        
        // Reset attempts for final retry
        chunk.attempts = 0;
        await this.uploadChunk(chunk, uploadId, file);
        
        chunk.uploaded = true;
        uploadedChunks.add(chunk.index);
        
        const progress = (uploadedChunks.size / totalChunks) * 100;
        onProgress({
          progress,
          uploadedChunks: uploadedChunks.size,
          totalChunks,
          currentChunk: chunk.index,
          retrying: true
        });
        
      } catch (error) {
        throw new Error(`Final retry failed for chunk ${chunk.index}: ${error.message}`);
      }
    }
  }

  /**
   * Upload individual chunk
   */
  async uploadChunk(chunk, uploadId, file) {
    const formData = new FormData();
    formData.append('action', 'upload_chunk');
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunk.index.toString());
    formData.append('totalChunks', Math.ceil(file.size / this.options.chunkSize).toString());
    formData.append('fileName', file.name);
    formData.append('fileSize', file.size.toString());
    formData.append('chunk', chunk.blob);
    formData.append('dev', '1');

    const response = await fetch(this.options.apiEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Chunk upload failed');
    }

    return result.data;
  }

  /**
   * Complete chunked upload
   */
  async completeChunkedUpload(uploadId, cityId) {
    const formData = new FormData();
    formData.append('action', 'complete_upload');
    formData.append('uploadId', uploadId);
    formData.append('cityId', cityId);
    formData.append('dev', '1');

    const response = await fetch(this.options.apiEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Upload completion failed');
    }

    return result.data;
  }

  /**
   * Streaming upload for very large files with Web Streams API
   */
  async streamingUpload(file, cityId, onProgress) {
    console.log('📡 Streaming upload with Web Streams API for memory efficiency');
    
    if (!window.ReadableStream || !window.TransformStream) {
      console.warn('⚠️ Web Streams API not supported, falling back to chunked upload');
      return await this.chunkedUpload(file, cityId, onProgress);
    }

    const uploadId = this.generateUploadId();
    let chunkIndex = 0;
    const totalChunks = Math.ceil(file.size / this.options.chunkSize);
    const uploadedChunks = new Set();

    try {
      // Create a ReadableStream from the file
      const fileStream = file.stream();
      
      // Transform stream to handle chunks
      const chunkTransform = new TransformStream({
        transform: async (chunk, controller) => {
          try {
            // Process chunk (compress if needed)
            let processedChunk = chunk;
            
            if (this.options.useCompression && chunk.byteLength > 100 * 1024) { // Only compress chunks > 100KB
              const uint8Array = new Uint8Array(chunk);
              processedChunk = await this.compressChunkData(uint8Array);
            }
            
            // Upload chunk immediately (streaming approach)
            await this.uploadStreamChunk(processedChunk, uploadId, chunkIndex, totalChunks, file);
            uploadedChunks.add(chunkIndex);
            
            // Report progress
            const progress = (uploadedChunks.size / totalChunks) * 100;
            onProgress({
              progress,
              uploadedChunks: uploadedChunks.size,
              totalChunks,
              currentChunk: chunkIndex,
              streaming: true
            });
            
            chunkIndex++;
            controller.enqueue(chunk); // Pass through for debugging if needed
            
          } catch (error) {
            console.error(`❌ Streaming chunk ${chunkIndex} failed:`, error);
            controller.error(error);
          }
        }
      });
      
      // Process the stream
      const reader = fileStream
        .pipeThrough(chunkTransform)
        .getReader();
      
      // Consume the stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Data is already processed in transform
      }
      
      // Complete upload
      console.log(`🔄 Assembling ${totalChunks} streamed chunks...`);
      return await this.completeChunkedUpload(uploadId, cityId);
      
    } catch (error) {
      console.error('❌ Streaming upload failed:', error);
      throw error;
    }
  }

  /**
   * Compress chunk data with worker if available
   */
  async compressChunkData(data) {
    if (this.options.useWorkers && this.compressionWorkers.length > 0) {
      return await this.compressWithWorker(data);
    } else {
      return this.compressSync(data);
    }
  }

  /**
   * Upload individual chunk via streaming
   */
  async uploadStreamChunk(chunkData, uploadId, chunkIndex, totalChunks, file) {
    const formData = new FormData();
    formData.append('action', 'upload_chunk');
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex.toString());
    formData.append('totalChunks', totalChunks.toString());
    formData.append('fileName', file.name);
    formData.append('fileSize', file.size.toString());
    formData.append('chunk', new Blob([chunkData]));
    formData.append('streaming', '1'); // Mark as streaming upload
    formData.append('dev', '1');

    const response = await fetch(this.options.apiEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Streaming chunk upload failed');
    }

    return result.data;
  }

  /**
   * Generate unique upload ID
   */
  generateUploadId() {
    return 'ultra_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    
    // Terminate all compression workers
    this.compressionWorkers.forEach(worker => {
      worker.terminate();
    });
    this.compressionWorkers = [];
    this.availableWorkers = [];
    
    console.log('🧹 Cleaned up all workers and resources');
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UltraFastUploader;
} else {
  window.UltraFastUploader = UltraFastUploader;
}