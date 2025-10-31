<?php
// api/auth.php
declare(strict_types=1);
session_start();
header('Content-Type: application/json; charset=utf-8');

// ======== Config ========
$ROOT = dirname(__DIR__);
$USERS_FILE = $ROOT . '/data/users.json';
$SESSION_TIMEOUT = 3600; // 1 hour

// Default admin user (change password in production!)
$DEFAULT_ADMIN = [
    'username' => 'admin',
    'password' => password_hash('admin123', PASSWORD_DEFAULT),
    'role' => 'admin',
    'created' => time()
];

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

function load_users(): array {
    if (!file_exists($USERS_FILE)) {
        global $DEFAULT_ADMIN;
        save_users([$DEFAULT_ADMIN]);
        return [$DEFAULT_ADMIN];
    }
    $raw = @file_get_contents($USERS_FILE);
    return $raw ? json_decode($raw, true) ?: [] : [];
}

function save_users(array $users): void {
    global $USERS_FILE, $ROOT;
    $dataDir = dirname($USERS_FILE);
    if (!is_dir($dataDir)) mkdir($dataDir, 0775, true);
    file_put_contents($USERS_FILE, json_encode($users, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

function validate_session(): bool {
    global $SESSION_TIMEOUT;
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

function get_authenticated_user(): ?array {
    if (!validate_session()) return null;
    $users = load_users();
    foreach ($users as $user) {
        if ($user['username'] === $_SESSION['user_id']) {
            return $user;
        }
    }
    return null;
}

// ======== CORS ========
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    exit;
}
header('Access-Control-Allow-Origin: *');

// ======== Router ========
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? $_POST['action'] ?? '';

// ---------- LOGIN ----------
if ($method === 'POST' && $action === 'login') {
    $username = trim($_POST['username'] ?? '');
    $password = trim($_POST['password'] ?? '');
    
    if (!$username || !$password) {
        json_err('Username e password são obrigatórios');
    }
    
    // Rate limiting (simple)
    $attempts_key = 'login_attempts_' . $_SERVER['REMOTE_ADDR'];
    $attempts = $_SESSION[$attempts_key] ?? 0;
    $last_attempt = $_SESSION[$attempts_key . '_time'] ?? 0;
    
    if ($attempts >= 5 && time() - $last_attempt < 900) { // 15 minutes
        json_err('Muitas tentativas. Tente novamente em 15 minutos.', 429);
    }
    
    $users = load_users();
    $user = null;
    foreach ($users as $u) {
        if ($u['username'] === $username) {
            $user = $u;
            break;
        }
    }
    
    if (!$user || !password_verify($password, $user['password'])) {
        $_SESSION[$attempts_key] = $attempts + 1;
        $_SESSION[$attempts_key . '_time'] = time();
        json_err('Credenciais inválidas', 401);
    }
    
    // Reset attempts on successful login
    unset($_SESSION[$attempts_key], $_SESSION[$attempts_key . '_time']);
    
    $_SESSION['user_id'] = $user['username'];
    $_SESSION['last_activity'] = time();
    
    json_ok([
        'username' => $user['username'],
        'role' => $user['role']
    ]);
}

// ---------- LOGOUT ----------
if ($method === 'POST' && $action === 'logout') {
    session_destroy();
    json_ok(['message' => 'Logout realizado com sucesso']);
}

// ---------- CHECK SESSION ----------
if ($method === 'GET' && $action === 'check') {
    $user = get_authenticated_user();
    if ($user) {
        json_ok([
            'username' => $user['username'],
            'role' => $user['role']
        ]);
    } else {
        json_err('Não autenticado', 401);
    }
}

// ---------- CHANGE PASSWORD ----------
if ($method === 'POST' && $action === 'change-password') {
    $user = get_authenticated_user();
    if (!$user) json_err('Não autenticado', 401);
    
    $current = trim($_POST['current_password'] ?? '');
    $new = trim($_POST['new_password'] ?? '');
    
    if (!$current || !$new) {
        json_err('Senhas são obrigatórias');
    }
    
    if (strlen($new) < 6) {
        json_err('Nova senha deve ter pelo menos 6 caracteres');
    }
    
    if (!password_verify($current, $user['password'])) {
        json_err('Senha atual incorreta', 401);
    }
    
    $users = load_users();
    foreach ($users as &$u) {
        if ($u['username'] === $user['username']) {
            $u['password'] = password_hash($new, PASSWORD_DEFAULT);
            break;
        }
    }
    
    save_users($users);
    json_ok(['message' => 'Senha alterada com sucesso']);
}

json_err('Ação não encontrada', 404);
?>