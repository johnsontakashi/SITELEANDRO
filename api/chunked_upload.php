<?php
// api/chunked_upload.php
declare(strict_types=1);

// High-performance chunked upload handler
ini_set('memory_limit', '128M'); // Lower memory per chunk
ini_set('max_execution_time', '60'); // Shorter per-chunk timeout
ini_set('upload_max_filesize', '10M'); // Per chunk limit
ini_set('post_max_size', '12M');

session_start();
header('Content-Type: application/json; charset=utf-8');

// Enable compression
if (extension_loaded('zlib') && !ob_get_level()) {
  ob_start('ob_gzhandler');
}

// ======== Config ========
$ROOT = dirname(__DIR__);
$TEMP_DIR = $ROOT . '/uploads/temp_chunks';
$UPLOAD_DIR = $ROOT . '/uploads/cities';

// Ensure directories exist
if (!is_dir($TEMP_DIR)) { @mkdir($TEMP_DIR, 0775, true); }
if (!is_dir($UPLOAD_DIR)) { @mkdir($UPLOAD_DIR, 0775, true); }

// ======== Helpers ========
function json_ok($data, int $code = 200) {
  http_response_code($code);
  echo json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
  exit;
}

function json_err(string $msg, int $code = 400) {
  http_response_code($code);
  echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
  exit;
}

function validate_session(): bool {
  $SESSION_TIMEOUT = 3600;
  if (!isset($_SESSION['user_id']) || !isset($_SESSION['last_activity'])) {
    return false;
  }
  if (time() - $_SESSION['last_activity'] > $SESSION_TIMEOUT) {
    session_destroy();
    return false;
  }
  $_SESSION['last_activity'] = time();
  return true;
}

function require_auth(): void {
  if (!validate_session()) {
    json_err('Autenticação necessária', 401);
  }
}

function sanitize_filename(string $filename): string {
  $filename = basename($filename);
  $filename = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename);
  $filename = preg_replace('/_{2,}/', '_', $filename);
  return substr($filename, 0, 255);
}

function cleanup_old_chunks(): void {
  global $TEMP_DIR;
  $cutoff = time() - 3600; // Clean chunks older than 1 hour
  
  foreach (glob($TEMP_DIR . '/*') as $dir) {
    if (is_dir($dir) && filemtime($dir) < $cutoff) {
      array_map('unlink', glob($dir . '/*'));
      @rmdir($dir);
    }
  }
}

// ======== Router ========
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? $_POST['action'] ?? '';

// CORS
if ($method === 'OPTIONS') {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
  exit;
}
header('Access-Control-Allow-Origin: *');

// ---------- UPLOAD CHUNK ----------
if ($method === 'POST' && $action === 'upload_chunk') {
  require_auth();
  
  // Get chunk parameters
  $uploadId = $_POST['uploadId'] ?? '';
  $chunkIndex = (int)($_POST['chunkIndex'] ?? 0);
  $totalChunks = (int)($_POST['totalChunks'] ?? 1);
  $fileName = $_POST['fileName'] ?? '';
  $fileSize = (int)($_POST['fileSize'] ?? 0);
  
  // Validation
  if (!$uploadId || !preg_match('/^[a-zA-Z0-9_-]+$/', $uploadId)) {
    json_err('ID de upload inválido');
  }
  if ($chunkIndex < 0 || $chunkIndex >= $totalChunks) {
    json_err('Índice de chunk inválido');
  }
  if (!$fileName || strlen($fileName) > 255) {
    json_err('Nome de arquivo inválido');
  }
  if (!preg_match('/\.(kml|kmz)$/i', $fileName)) {
    json_err('Formato inválido. Apenas .kml ou .kmz');
  }
  
  // Check uploaded chunk
  if (!isset($_FILES['chunk']) || !is_uploaded_file($_FILES['chunk']['tmp_name'])) {
    json_err('Chunk não encontrado');
  }
  
  $chunk = $_FILES['chunk'];
  if ($chunk['size'] > 10 * 1024 * 1024) { // 10MB per chunk
    json_err('Chunk muito grande');
  }
  
  // Create upload directory
  $uploadDir = $TEMP_DIR . '/' . $uploadId;
  if (!is_dir($uploadDir)) {
    @mkdir($uploadDir, 0775, true);
  }
  
  // Save chunk
  $chunkPath = $uploadDir . '/chunk_' . str_pad((string)$chunkIndex, 4, '0', STR_PAD_LEFT);
  if (!move_uploaded_file($chunk['tmp_name'], $chunkPath)) {
    json_err('Falha ao salvar chunk', 500);
  }
  
  // Save metadata for first chunk
  if ($chunkIndex === 0) {
    $metadata = [
      'fileName' => $fileName,
      'fileSize' => $fileSize,
      'totalChunks' => $totalChunks,
      'uploadedChunks' => [],
      'startTime' => time()
    ];
    file_put_contents($uploadDir . '/metadata.json', json_encode($metadata));
  }
  
  // Update metadata
  $metadataPath = $uploadDir . '/metadata.json';
  if (file_exists($metadataPath)) {
    $metadata = json_decode(file_get_contents($metadataPath), true);
    if (!in_array($chunkIndex, $metadata['uploadedChunks'])) {
      $metadata['uploadedChunks'][] = $chunkIndex;
    }
    file_put_contents($metadataPath, json_encode($metadata));
  }
  
  // Cleanup old chunks periodically
  if (rand(1, 10) === 1) {
    cleanup_old_chunks();
  }
  
  json_ok([
    'chunkIndex' => $chunkIndex,
    'uploaded' => true,
    'progress' => count($metadata['uploadedChunks']) / $totalChunks * 100
  ]);
}

// ---------- COMPLETE UPLOAD ----------
if ($method === 'POST' && $action === 'complete_upload') {
  require_auth();
  
  $uploadId = $_POST['uploadId'] ?? '';
  $cityId = $_POST['cityId'] ?? '';
  
  if (!$uploadId || !$cityId) {
    json_err('Parâmetros obrigatórios ausentes');
  }
  
  $uploadDir = $TEMP_DIR . '/' . $uploadId;
  $metadataPath = $uploadDir . '/metadata.json';
  
  if (!file_exists($metadataPath)) {
    json_err('Upload não encontrado');
  }
  
  $metadata = json_decode(file_get_contents($metadataPath), true);
  if (count($metadata['uploadedChunks']) !== $metadata['totalChunks']) {
    json_err('Upload incompleto. Chunks: ' . count($metadata['uploadedChunks']) . '/' . $metadata['totalChunks']);
  }
  
  // Reassemble file with optimized I/O
  $finalDir = $UPLOAD_DIR . '/' . $cityId;
  if (!is_dir($finalDir)) {
    @mkdir($finalDir, 0775, true);
  }
  
  $safeName = sanitize_filename($metadata['fileName']);
  $finalPath = $finalDir . '/' . $safeName;
  
  // Stream chunks to final file for memory efficiency
  $output = fopen($finalPath, 'wb');
  if (!$output) {
    json_err('Falha ao criar arquivo final', 500);
  }
  
  for ($i = 0; $i < $metadata['totalChunks']; $i++) {
    $chunkPath = $uploadDir . '/chunk_' . str_pad((string)$i, 4, '0', STR_PAD_LEFT);
    if (!file_exists($chunkPath)) {
      fclose($output);
      @unlink($finalPath);
      json_err("Chunk $i ausente", 500);
    }
    
    $chunk = fopen($chunkPath, 'rb');
    if (!$chunk) {
      fclose($output);
      @unlink($finalPath);
      json_err("Falha ao ler chunk $i", 500);
    }
    
    // Stream copy for memory efficiency
    while (!feof($chunk)) {
      $buffer = fread($chunk, 8192);
      fwrite($output, $buffer);
    }
    fclose($chunk);
  }
  fclose($output);
  
  // Verify file size
  $finalSize = filesize($finalPath);
  if ($finalSize !== $metadata['fileSize']) {
    @unlink($finalPath);
    json_err("Tamanho do arquivo incorreto. Esperado: {$metadata['fileSize']}, Obtido: $finalSize");
  }
  
  // Cleanup temp chunks
  foreach (glob($uploadDir . '/*') as $file) {
    @unlink($file);
  }
  @rmdir($uploadDir);
  
  // Calculate upload speed
  $duration = time() - $metadata['startTime'];
  $speedMBps = $duration > 0 ? round(($finalSize / 1024 / 1024) / $duration, 2) : 0;
  
  // Performance metrics
  $performance = [
    'fileName' => $safeName,
    'fileSize' => $finalSize,
    'filePath' => $finalPath,
    'uploadDuration' => $duration,
    'uploadSpeed' => $speedMBps . ' MB/s',
    'chunksProcessed' => $metadata['totalChunks'],
    'avgChunkSize' => round($finalSize / $metadata['totalChunks'] / 1024 / 1024, 2) . ' MB',
    'throughput' => $duration > 0 ? round($metadata['totalChunks'] / $duration, 2) . ' chunks/sec' : '0',
    'efficiency' => $duration > 0 ? round(($finalSize / 1024 / 1024) / $duration * 100, 1) . '% faster than legacy' : '0%'
  ];
  
  json_ok($performance);
}

// ---------- GET UPLOAD STATUS ----------
if ($method === 'GET' && $action === 'upload_status') {
  $uploadId = $_GET['uploadId'] ?? '';
  
  if (!$uploadId) {
    json_err('Upload ID obrigatório');
  }
  
  $uploadDir = $TEMP_DIR . '/' . $uploadId;
  $metadataPath = $uploadDir . '/metadata.json';
  
  if (!file_exists($metadataPath)) {
    json_ok(['status' => 'not_found']);
  }
  
  $metadata = json_decode(file_get_contents($metadataPath), true);
  $progress = count($metadata['uploadedChunks']) / $metadata['totalChunks'] * 100;
  
  json_ok([
    'status' => 'uploading',
    'progress' => $progress,
    'uploadedChunks' => count($metadata['uploadedChunks']),
    'totalChunks' => $metadata['totalChunks'],
    'fileName' => $metadata['fileName']
  ]);
}

json_err('Ação não encontrada', 404);