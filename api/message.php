<?php
// api/message.php
session_start();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');

// Authentication check for POST operations
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

$FILE = __DIR__ . '/../data/message.json';

// ===== Config mínima de "auth" sem banco =====
// Troque por um valor difícil e guarde fora do Git, se puder (ex.: em .env).
$ADMIN_TOKEN = 'troque-este-token-seguro';

// Util: resposta JSON
function j($ok, $data=null, $error=null, $code=200){
  http_response_code($code);
  echo json_encode(['ok'=>$ok, 'data'=>$data, 'error'=>$error], JSON_UNESCAPED_UNICODE);
  exit;
}

// Garante arquivo com valor default
if (!file_exists($FILE)) {
  @mkdir(dirname($FILE), 0775, true);
  file_put_contents($FILE, json_encode([
    'text' => '',
    'updated_at' => date('c')
  ], JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
}

$method = $_SERVER['REQUEST_METHOD'];

// GET => lê mensagem pública
if ($method === 'GET') {
  $raw = file_get_contents($FILE);
  $json = json_decode($raw, true);
  if (!is_array($json)) $json = ['text'=>'','updated_at'=>date('c')];
  j(true, $json);
}

// POST => atualiza mensagem (requer autenticação)
if ($method === 'POST') {
  if (!validate_session()) {
    j(false, null, 'Autenticação necessária', 401);
  }

  // aceita JSON ou multipart
  $input = file_get_contents('php://input');
  $payload = json_decode($input, true);
  if (!$payload) $payload = $_POST;

  $text = trim($payload['text'] ?? '');

  // Segurança: se quiser bloquear HTML, descomente:
  // $text = strip_tags($text);

  // Limite opcional
  if (mb_strlen($text) > 2000) j(false, null, 'Mensagem muito longa (máx. 2000 caracteres)', 400);

  // grava com trava de arquivo
  $record = json_encode(['text'=>$text, 'updated_at'=>date('c')], JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT);

  $fp = fopen($FILE, 'c+');
  if (!$fp) j(false, null, 'Falha ao abrir storage', 500);
  if (!flock($fp, LOCK_EX)) { fclose($fp); j(false, null, 'Falha no lock', 500); }
  ftruncate($fp, 0);
  fwrite($fp, $record);
  fflush($fp);
  flock($fp, LOCK_UN);
  fclose($fp);

  j(true, ['saved'=>true]);
}

j(false, null, 'Método não suportado', 405);
