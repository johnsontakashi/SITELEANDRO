<?php
// api/cities.php
declare(strict_types=1);
session_start();
header('Content-Type: application/json; charset=utf-8');

// ======== Config ========
$ROOT = dirname(__DIR__);
$UPLOAD_DIR = $ROOT . '/uploads/cities';
$DB_JSON = $ROOT . '/uploads/cities/_index.json'; // "índice" simples (metadados)
$BASE_URL = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/'); // /api
$SITE_ROOT = rtrim($BASE_URL, '/api'); // raiz do site
$FILES_BASE_URL = $SITE_ROOT . '/uploads/cities'; // URL pública dos arquivos

// Garante estrutura
if (!is_dir($UPLOAD_DIR)) { @mkdir($UPLOAD_DIR, 0775, true); }
if (!file_exists($DB_JSON)) { @file_put_contents($DB_JSON, json_encode([])); }

// ======== Helpers ========
function json_ok($data, int $code = 200){
  http_response_code($code);
  echo json_encode(['ok'=>true,'data'=>$data], JSON_UNESCAPED_UNICODE);
  exit;
}
function json_err(string $msg, int $code = 400){
  http_response_code($code);
  echo json_encode(['ok'=>false,'error'=>$msg], JSON_UNESCAPED_UNICODE);
  exit;
}
function load_index(string $file): array {
  $raw = @file_get_contents($file);
  if ($raw === false) return [];
  $arr = json_decode($raw, true);
  return is_array($arr) ? $arr : [];
}
function save_index(string $file, array $arr): void {
  file_put_contents($file, json_encode(array_values($arr), JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
}
function uid(): string { return 'c_'.bin2hex(random_bytes(6)); }
function clean_prefix(string $p): string {
  $p = strtoupper(preg_replace('/[^A-Za-z0-9]/','', $p));
  return substr($p, 0, 8);
}
function sanitize_filename(string $filename): string {
  // Remove path separators and dangerous characters
  $filename = basename($filename);
  $filename = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename);
  $filename = preg_replace('/_{2,}/', '_', $filename); // Multiple underscores to single
  return substr($filename, 0, 255); // Limit length
}
function validate_path(string $path, string $allowed_base): bool {
  $real_path = realpath($path);
  $real_base = realpath($allowed_base);
  return $real_path !== false && 
         $real_base !== false && 
         strpos($real_path, $real_base) === 0;
}
function safe_delete_directory(string $dir, string $allowed_base): bool {
  if (!validate_path($dir, $allowed_base)) {
    return false;
  }
  
  if (!is_dir($dir)) {
    return false;
  }
  
  $iterator = new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS);
  $files = new RecursiveIteratorIterator($iterator, RecursiveIteratorIterator::CHILD_FIRST);
  
  foreach ($files as $f) {
    if (!validate_path($f->getPathname(), $allowed_base)) {
      continue; // Skip files outside allowed base
    }
    $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
  }
  
  return @rmdir($dir);
}
function city_to_prefix(string $name): string {
  $clean = preg_replace('/[^A-Za-z ]/','', iconv('UTF-8','ASCII//TRANSLIT',$name));
  $clean = trim($clean ?: 'GEN');
  $parts = preg_split('/\s+/', $clean);
  $base = $parts[0] ?? 'GEN';
  if (preg_match('/^(SAO|SANTO|SANTA|SANTANA|VILA|BOM|NOVA)$/i', $base) && !empty($parts[1])) {
    $base = $parts[1];
  }
  return strtoupper(substr($base,0,3));
}
function is_kml(string $n): bool { return preg_match('/\.kml$/i', $n) === 1; }
function is_kmz(string $n): bool { return preg_match('/\.kmz$/i', $n) === 1; }

// Authentication helper
function validate_session(): bool {
  $SESSION_TIMEOUT = 3600; // 1 hour
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
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'Autenticação necessária'], JSON_UNESCAPED_UNICODE);
    exit;
  }
}

// ======== Router ========
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? $_POST['action'] ?? '';
$index = load_index($DB_JSON);

// CORS simples
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
  exit;
}
header('Access-Control-Allow-Origin: *');

// ---------- LIST ----------
if ($method === 'GET' && ($action === '' || $action === 'list')) {
  $out = array_map(function($c) use ($FILES_BASE_URL){
    if (!empty($c['file']) && !empty($c['file']['path'])) {
      $c['file']['url'] = $FILES_BASE_URL . '/' . $c['id'] . '/' . rawurlencode($c['file']['name']);
    }
    // garante chaves novas
    $c['isDefault'] = (bool)($c['isDefault'] ?? false);
    $c['defaultAt'] = $c['defaultAt'] ?? null; // timestamp UNIX ou null
    return $c;
  }, $index);
  json_ok($out);
}

// ---------- GET ----------
if ($method === 'GET' && $action === 'get') {
  $id = $_GET['id'] ?? '';
  
  // Validate ID format
  if (!preg_match('/^c_[a-f0-9]{12}$/', $id)) {
    json_err('ID inválido');
  }
  
  foreach ($index as $c) {
    if ($c['id'] === $id) {
      if (!empty($c['file']) && !empty($c['file']['path'])) {
        $c['file']['url'] = $FILES_BASE_URL . '/' . $c['id'] . '/' . rawurlencode($c['file']['name']);
      }
      $c['isDefault'] = (bool)($c['isDefault'] ?? false);
      $c['defaultAt'] = $c['defaultAt'] ?? null;
      json_ok($c);
    }
  }
  json_err('Cidade não encontrada', 404);
}

// ---------- CREATE/UPDATE ----------
if ($method === 'POST' && ($action === 'create' || $action === 'update')) {
  require_auth();
  $name = trim($_POST['name'] ?? '');
  $prefix = trim($_POST['prefix'] ?? '');
  $id = $action === 'update' ? trim($_POST['id'] ?? '') : '';

  // Enhanced validation
  if ($name === '') json_err('Nome da cidade é obrigatório');
  if (strlen($name) > 100) json_err('Nome muito longo (máx. 100 caracteres)');
  if (!preg_match('/^[A-Za-z0-9\s\-_áéíóúàèìòùâêîôûãõçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÇ]+$/', $name)) {
    json_err('Nome contém caracteres inválidos');
  }
  
  if ($prefix && strlen($prefix) > 8) json_err('Prefixo muito longo (máx. 8 caracteres)');
  if ($prefix && !preg_match('/^[A-Za-z0-9]+$/', $prefix)) {
    json_err('Prefixo contém caracteres inválidos');
  }
  
  // Validate ID for updates
  if ($action === 'update') {
    if (!preg_match('/^c_[a-f0-9]{12}$/', $id)) {
      json_err('ID inválido');
    }
  }

  if ($action === 'create') {
    $id = uid();
    $prefix = $prefix !== '' ? clean_prefix($prefix) : city_to_prefix($name);
    $city = [
      'id' => $id,
      'name' => $name,
      'prefix' => $prefix,
      'file' => null,
      'updatedAt' => time(),
      'isDefault' => false,
      'defaultAt' => null
    ];
    $index[] = $city;
  } else {
    $found = false;
    foreach ($index as &$c) {
      if ($c['id'] === $id) {
        $c['name'] = $name;
        $c['prefix'] = $prefix !== '' ? clean_prefix($prefix) : ($c['prefix'] ?? city_to_prefix($name));
        $c['updatedAt'] = time();
        if (!isset($c['isDefault'])) $c['isDefault'] = false;
        if (!isset($c['defaultAt'])) $c['defaultAt'] = null;
        $found = true;
        break;
      }
    }
    unset($c);
    if (!$found) json_err('Cidade não encontrada', 404);
  }

  // upload de arquivo (opcional)
  if (!empty($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
    $file = $_FILES['file'];
    $origName = $file['name'];
    $fileSize = $file['size'];
    
    // Enhanced validation
    if (!is_kml($origName) && !is_kmz($origName)) {
      json_err('Formato inválido. Envie .kml ou .kmz');
    }
    if ($fileSize > 50*1024*1024) json_err('Arquivo muito grande (máx. 50MB)');
    if ($fileSize < 10) json_err('Arquivo muito pequeno (mín. 10 bytes)');
    
    // Validate MIME type
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mimeType = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);
    
    $allowedMimes = ['application/vnd.google-earth.kml+xml', 'application/vnd.google-earth.kmz', 
                     'application/xml', 'text/xml', 'application/zip'];
    if (!in_array($mimeType, $allowedMimes)) {
      json_err('Tipo de arquivo não permitido: ' . $mimeType);
    }
    
    // Validate ID format
    if (!preg_match('/^c_[a-f0-9]{12}$/', $id)) {
      json_err('ID inválido');
    }
    
    $cityDir = $UPLOAD_DIR . '/' . $id;
    
    // Validate directory path
    if (!validate_path($cityDir, $UPLOAD_DIR)) {
      json_err('Caminho de diretório inválido');
    }
    
    if (!is_dir($cityDir)) @mkdir($cityDir, 0775, true);
    
    $safeName = sanitize_filename($origName);
    if (empty($safeName) || strlen($safeName) < 5) {
      json_err('Nome de arquivo inválido');
    }
    
    $target = $cityDir . '/' . $safeName;
    
    // Final path validation
    if (!validate_path($target, $UPLOAD_DIR)) {
      json_err('Caminho de arquivo inválido');
    }

    // remove arquivo antigo (se houver)
    foreach ($index as &$c) {
      if ($c['id'] === $id && !empty($c['file']['path'])) {
        $oldPath = $c['file']['path'];
        if (validate_path($oldPath, $UPLOAD_DIR) && file_exists($oldPath)) {
          @unlink($oldPath);
        }
      }
    }
    unset($c);

    if (!move_uploaded_file($file['tmp_name'], $target)) {
      json_err('Falha ao salvar arquivo no servidor', 500);
    }

    // grava metadados
    foreach ($index as &$c) {
      if ($c['id'] === $id) {
        $c['file'] = [
          'name' => $safeName,
          'mime' => mime_content_type($target) ?: (is_kmz($safeName) ? 'application/vnd.google-earth.kmz' : 'application/vnd.google-earth.kml+xml'),
          'size' => filesize($target),
          'path' => $target
        ];
        $c['updatedAt'] = time();
        break;
      }
    }
    unset($c);
  }

  save_index($DB_JSON, $index);

  // retorna registro atualizado
  foreach ($index as $c) {
    if ($c['id'] === $id) {
      if (!empty($c['file'])) {
        $c['file']['url'] = $FILES_BASE_URL . '/' . $c['id'] . '/' . rawurlencode($c['file']['name']);
      }
      $c['isDefault'] = (bool)($c['isDefault'] ?? false);
      $c['defaultAt'] = $c['defaultAt'] ?? null;
      json_ok($c, $action==='create'?201:200);
    }
  }
  json_err('Erro inesperado', 500);
}

// ---------- SET DEFAULT (⭐) ----------
if ($method === 'POST' && $action === 'set_default') {
  require_auth();
  $id = trim($_POST['id'] ?? '');
  if ($id === '') json_err('ID obrigatório');

  $found = false;
  foreach ($index as &$c) {
    if ($c['id'] === $id) {
      $c['isDefault'] = true;
      $c['defaultAt'] = time(); // 👈 grava o dia/horário em que foi marcado
      $found = true;
    } else {
      $c['isDefault'] = false;
      // mantemos o defaultAt antigo só do atual? Vamos limpar dos outros:
      if (isset($c['defaultAt'])) $c['defaultAt'] = null;
    }
  }
  unset($c);

  if (!$found) json_err('Cidade não encontrada', 404);

  save_index($DB_JSON, $index);

  // devolve lista já com URLs
  $out = array_map(function($c) use ($FILES_BASE_URL){
    if (!empty($c['file']) && !empty($c['file']['path'])) {
      $c['file']['url'] = $FILES_BASE_URL . '/' . $c['id'] . '/' . rawurlencode($c['file']['name']);
    }
    $c['isDefault'] = (bool)($c['isDefault'] ?? false);
    $c['defaultAt'] = $c['defaultAt'] ?? null;
    return $c;
  }, $index);

  json_ok($out, 200);
}

// ---------- DELETE ----------
if (($method === 'POST' || $method === 'DELETE') && $action === 'delete') {
  require_auth();
  $id = $_POST['id'] ?? ($_GET['id'] ?? '');
  
  // Validate ID format
  if (!preg_match('/^c_[a-f0-9]{12}$/', $id)) {
    json_err('ID inválido');
  }
  
  $new = [];
  $removed = null;
  foreach ($index as $c) {
    if ($c['id'] === $id) { $removed = $c; continue; }
    $new[] = $c;
  }
  if (!$removed) json_err('Cidade não encontrada', 404);

  // apaga diretório com arquivos usando função segura
  $dir = $UPLOAD_DIR . '/' . $id;
  if (is_dir($dir) && validate_path($dir, $UPLOAD_DIR)) {
    safe_delete_directory($dir, $UPLOAD_DIR);
  }

  save_index($DB_JSON, $new);
  json_ok(['id'=>$id, 'deleted'=>true]);
}

// ---------- 404 ----------
json_err('Rota não encontrada', 404);
