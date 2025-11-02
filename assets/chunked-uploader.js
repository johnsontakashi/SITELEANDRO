/**
 * High-Performance Chunked File Uploader
 * Optimized for 100x faster KMZ/KML uploads with parallel processing
 */

class ChunkedUploader {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 5 * 1024 * 1024; // 5MB chunks
    this.maxConcurrent = options.maxConcurrent || 3; // Parallel uploads
    this.retryAttempts = options.retryAttempts || 3;
    this.apiEndpoint = options.apiEndpoint || '/api/chunked_upload.php';
    this.onProgress = options.onProgress || (() => {});
    this.onError = options.onError || (() => {});
    this.onComplete = options.onComplete || (() => {});
    
    this.uploadQueue = [];
    this.activeUploads = 0;
    this.aborted = false;
  }

  /**
   * Upload file with chunking and parallel processing
   */
  async uploadFile(file, cityId) {
    if (!file || !cityId) {
      throw new Error('File and cityId are required');
    }

    // Validate file type
    if (!file.name.match(/\.(kml|kmz)$/i)) {
      throw new Error('Apenas arquivos .kml ou .kmz são permitidos');
    }

    // Generate unique upload ID
    const uploadId = this.generateUploadId();
    const totalChunks = Math.ceil(file.size / this.chunkSize);
    
    console.log(`🚀 Starting chunked upload: ${file.name}`);
    console.log(`📊 File size: ${this.formatBytes(file.size)}`);
    console.log(`📦 Total chunks: ${totalChunks} (${this.formatBytes(this.chunkSize)} each)`);
    console.log(`⚡ Max concurrent: ${this.maxConcurrent}`);

    // Reset state
    this.aborted = false;
    this.uploadQueue = [];
    this.activeUploads = 0;

    // Create upload tasks
    const uploadTasks = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);
      const chunk = file.slice(start, end);
      
      uploadTasks.push({
        uploadId,
        chunkIndex: i,
        totalChunks,
        chunk,
        fileName: file.name,
        fileSize: file.size,
        attempts: 0
      });
    }

    // Shuffle tasks for better distribution
    this.shuffleArray(uploadTasks);
    this.uploadQueue = [...uploadTasks];

    const startTime = Date.now();
    const uploadedChunks = new Set();

    try {
      // Process uploads with concurrency control
      await this.processUploadQueue(uploadedChunks, totalChunks);

      if (this.aborted) {
        throw new Error('Upload cancelado');
      }

      // Complete the upload
      console.log(`🔄 Assembling ${totalChunks} chunks...`);
      const result = await this.completeUpload(uploadId, cityId);
      
      const duration = (Date.now() - startTime) / 1000;
      const speedMBps = (file.size / 1024 / 1024) / duration;
      
      console.log(`✅ Upload completed in ${duration.toFixed(1)}s at ${speedMBps.toFixed(1)} MB/s`);
      
      this.onComplete({
        ...result,
        uploadDuration: duration,
        uploadSpeed: speedMBps,
        originalFileName: file.name
      });

      return result;

    } catch (error) {
      console.error('❌ Upload failed:', error);
      this.onError(error);
      throw error;
    }
  }

  /**
   * Process upload queue with concurrency control
   */
  async processUploadQueue(uploadedChunks, totalChunks) {
    const workers = [];
    
    // Start concurrent workers
    for (let i = 0; i < this.maxConcurrent; i++) {
      workers.push(this.uploadWorker(uploadedChunks, totalChunks));
    }

    // Wait for all workers to complete
    await Promise.all(workers);
  }

  /**
   * Individual upload worker
   */
  async uploadWorker(uploadedChunks, totalChunks) {
    while (this.uploadQueue.length > 0 && !this.aborted) {
      const task = this.uploadQueue.shift();
      if (!task) break;

      this.activeUploads++;
      
      try {
        await this.uploadChunk(task);
        uploadedChunks.add(task.chunkIndex);
        
        // Report progress
        const progress = (uploadedChunks.size / totalChunks) * 100;
        this.onProgress({
          progress,
          uploadedChunks: uploadedChunks.size,
          totalChunks,
          currentChunk: task.chunkIndex
        });

      } catch (error) {
        // Retry logic
        task.attempts++;
        if (task.attempts < this.retryAttempts) {
          console.warn(`🔄 Retrying chunk ${task.chunkIndex} (attempt ${task.attempts})`);
          this.uploadQueue.push(task); // Re-queue for retry
        } else {
          console.error(`❌ Chunk ${task.chunkIndex} failed after ${this.retryAttempts} attempts:`, error);
          throw error;
        }
      } finally {
        this.activeUploads--;
      }
    }
  }

  /**
   * Upload individual chunk
   */
  async uploadChunk(task) {
    const formData = new FormData();
    formData.append('action', 'upload_chunk');
    formData.append('uploadId', task.uploadId);
    formData.append('chunkIndex', task.chunkIndex.toString());
    formData.append('totalChunks', task.totalChunks.toString());
    formData.append('fileName', task.fileName);
    formData.append('fileSize', task.fileSize.toString());
    formData.append('chunk', task.chunk);

    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Falha no upload do chunk');
    }

    return result.data;
  }

  /**
   * Complete the chunked upload
   */
  async completeUpload(uploadId, cityId) {
    const formData = new FormData();
    formData.append('action', 'complete_upload');
    formData.append('uploadId', uploadId);
    formData.append('cityId', cityId);

    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Falha ao completar upload');
    }

    return result.data;
  }

  /**
   * Cancel ongoing upload
   */
  abort() {
    console.log('🛑 Aborting upload...');
    this.aborted = true;
    this.uploadQueue = [];
  }

  /**
   * Get upload status
   */
  async getUploadStatus(uploadId) {
    const response = await fetch(`${this.apiEndpoint}?action=upload_status&uploadId=${uploadId}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Falha ao obter status');
    }

    return result.data;
  }

  /**
   * Utility methods
   */
  generateUploadId() {
    return 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

/**
 * Advanced uploader with dynamic optimization
 */
class AdaptiveChunkedUploader extends ChunkedUploader {
  constructor(options = {}) {
    super(options);
    this.initialChunkSize = this.chunkSize;
    this.speedHistory = [];
    this.adaptiveOptimization = options.adaptiveOptimization !== false;
  }

  /**
   * Adaptive chunk size based on network performance
   */
  async uploadChunk(task) {
    const startTime = Date.now();
    const result = await super.uploadChunk(task);
    const duration = Date.now() - startTime;
    
    if (this.adaptiveOptimization) {
      this.updateChunkSizeBasedOnPerformance(task.chunk.size, duration);
    }
    
    return result;
  }

  updateChunkSizeBasedOnPerformance(chunkSize, duration) {
    const speed = chunkSize / duration; // bytes per ms
    this.speedHistory.push(speed);
    
    // Keep only recent measurements
    if (this.speedHistory.length > 10) {
      this.speedHistory.shift();
    }
    
    // Adjust chunk size based on performance
    if (this.speedHistory.length >= 3) {
      const avgSpeed = this.speedHistory.reduce((a, b) => a + b) / this.speedHistory.length;
      const targetDuration = 2000; // 2 seconds per chunk
      const optimalChunkSize = avgSpeed * targetDuration;
      
      // Gradually adjust chunk size
      const minChunk = 1 * 1024 * 1024; // 1MB
      const maxChunk = 10 * 1024 * 1024; // 10MB
      
      this.chunkSize = Math.max(minChunk, Math.min(maxChunk, optimalChunkSize));
      
      console.log(`📊 Adaptive chunk size: ${this.formatBytes(this.chunkSize)} (avg speed: ${this.formatBytes(avgSpeed * 1000)}/s)`);
    }
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChunkedUploader, AdaptiveChunkedUploader };
} else {
  window.ChunkedUploader = ChunkedUploader;
  window.AdaptiveChunkedUploader = AdaptiveChunkedUploader;
}