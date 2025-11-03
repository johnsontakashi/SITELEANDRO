/**
 * Dedicated Web Worker for file compression
 * Uses fflate for maximum performance with parallel processing
 */

// Import fflate in worker context
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.1/lib/index.min.js');

// Worker message handler
self.addEventListener('message', async function(e) {
  const { id, action, data, options } = e.data;

  try {
    switch (action) {
      case 'compress':
        await compressData(id, data, options);
        break;
      case 'decompress':
        await decompressData(id, data, options);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
});

/**
 * Compress data using fflate with optimal settings
 */
async function compressData(id, data, options = {}) {
  const {
    level = 6,
    mem = 8,
    method = 'gzip'
  } = options;

  return new Promise((resolve) => {
    const startTime = performance.now();
    
    // Choose compression method based on data type and size
    const compressFunc = method === 'deflate' ? fflate.deflate : fflate.gzip;
    
    compressFunc(data, {
      level,
      mem
    }, (err, result) => {
      const duration = performance.now() - startTime;
      
      if (err) {
        self.postMessage({
          id,
          success: false,
          error: err.message
        });
        return;
      }

      // Calculate compression stats
      const originalSize = data.length;
      const compressedSize = result.length;
      const ratio = originalSize / compressedSize;
      const speedMBps = (originalSize / 1024 / 1024) / (duration / 1000);

      self.postMessage({
        id,
        success: true,
        result,
        stats: {
          originalSize,
          compressedSize,
          compressionRatio: ratio,
          duration,
          speedMBps
        }
      });
      
      resolve();
    });
  });
}

/**
 * Decompress data using fflate
 */
async function decompressData(id, data, options = {}) {
  const { method = 'gzip' } = options;

  return new Promise((resolve) => {
    const startTime = performance.now();
    
    const decompressFunc = method === 'deflate' ? fflate.inflate : fflate.gunzip;
    
    decompressFunc(data, (err, result) => {
      const duration = performance.now() - startTime;
      
      if (err) {
        self.postMessage({
          id,
          success: false,
          error: err.message
        });
        return;
      }

      self.postMessage({
        id,
        success: true,
        result,
        stats: {
          originalSize: data.length,
          decompressedSize: result.length,
          duration
        }
      });
      
      resolve();
    });
  });
}

// Worker initialization
self.postMessage({
  type: 'ready',
  message: 'Compression worker initialized'
});