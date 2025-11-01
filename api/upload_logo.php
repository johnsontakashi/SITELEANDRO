<?php
// api/upload_logo.php
header('Content-Type: application/json; charset=utf-8');

// ---- CONFIG ----
$iconsDir   = __DIR__ . '/../assets/icons/';
$uploadsDir = __DIR__ . '/../uploads/';
$manifest   = __DIR__ . '/../manifest.webmanifest';
$siteName   = 'GeoViewer Pro';
$shortName  = 'GeoViewer';

// Garante diretórios
if (!is_dir($iconsDir))   mkdir($iconsDir, 0775, true);
if (!is_dir($uploadsDir)) mkdir($uploadsDir, 0775, true);

// Verifica upload
if (!isset($_FILES['logo']) || $_FILES['logo']['error'] !== UPLOAD_ERR_OK) {
  echo json_encode(['ok'=>false, 'error'=>'Nenhum arquivo enviado.']); exit;
}

$tmp  = $_FILES['logo']['tmp_name'];
$mime = mime_content_type($tmp);
$allowed = ['image/png','image/jpeg','image/webp']; // (SVG dá mais trabalho no servidor)
// Dica: se quiser suportar SVG, instale Imagick e adicione 'image/svg+xml'
if (!in_array($mime, $allowed)) {
  echo json_encode(['ok'=>false, 'error'=>'Tipo de arquivo inválido. Use PNG/JPG/WEBP.']); exit;
}

// Carrega imagem (GD)
switch ($mime) {
  case 'image/png':  $img = imagecreatefrompng($tmp);  break;
  case 'image/jpeg': $img = imagecreatefromjpeg($tmp); break;
  case 'image/webp': $img = imagecreatefromwebp($tmp); break;
  default: $img = null;
}
if (!$img) { echo json_encode(['ok'=>false,'error'=>'Falha ao abrir a imagem.']); exit; }

// Normaliza para quadrado com fundo transparente
function make_square($src) {
  $w = imagesx($src); $h = imagesy($src);
  $size = max($w, $h);
  $dst = imagecreatetruecolor($size, $size);
  imagesavealpha($dst, true);
  $alpha = imagecolorallocatealpha($dst, 0,0,0,127);
  imagefill($dst, 0,0, $alpha);
  $x = (int)(($size - $w) / 2);
  $y = (int)(($size - $h) / 2);
  imagecopy($dst, $src, $x, $y, 0, 0, $w, $h);
  return $dst;
}
function resize_to($src, $size) {
  $dst = imagecreatetruecolor($size, $size);
  imagesavealpha($dst, true);
  $alpha = imagecolorallocatealpha($dst, 0,0,0,127);
  imagefill($dst, 0,0, $alpha);
  imagecopyresampled($dst, $src, 0,0, 0,0, $size, $size, imagesx($src), imagesy($src));
  return $dst;
}
// “maskable”: adiciona safe-area (padding ~12%) para evitar corte no círculo
function make_maskable($src, $outSize) {
  $pad = (int)round($outSize * 0.12);
  $canvas = imagecreatetruecolor($outSize, $outSize);
  imagesavealpha($canvas, true);
  $alpha = imagecolorallocatealpha($canvas, 0,0,0,127);
  imagefill($canvas, 0,0, $alpha);
  $iconSize = $outSize - ($pad * 2);
  $resized = resize_to($src, $iconSize);
  imagecopy($canvas, $resized, $pad, $pad, 0,0, $iconSize, $iconSize);
  imagedestroy($resized);
  return $canvas;
}

// Versão (timestamp)
$ver = time();

// Gera quadrado base
$base = make_square($img);

// Gera e salva ícones
function save_png($im, $path) {
  imagesavealpha($im, true);
  imagepng($im, $path, 9);
}

$icon192 = resize_to($base, 192);
$icon512 = resize_to($base, 512);
$mask512 = make_maskable($base, 512);
// Apple recomenda 180x180 (ou 192). Vamos gerar 180.
$apple180 = resize_to($base, 180);

$icon192Path = $iconsDir . "icon-192-$ver.png";
$icon512Path = $iconsDir . "icon-512-$ver.png";
$mask512Path = $iconsDir . "icon-512-maskable-$ver.png";
$applePath   = $iconsDir . "apple-touch-icon-$ver.png";

save_png($icon192, $icon192Path);
save_png($icon512, $icon512Path);
save_png($mask512, $mask512Path);
save_png($apple180, $applePath);

// Atualiza o favicon “live” como cópia de 192 (opcional)
copy($icon192Path, $uploadsDir.'logo.png'); // sua UI continua olhando uploads/logo.png

// Limpa até manter os 3 conjuntos mais novos
$files = glob($iconsDir.'icon-192-*.png');
rsort($files); // mais novos primeiro
for ($i=3; $i<count($files); $i++) {
  $oldVer = preg_replace('/^.*icon-192-(\d+)\.png$/', '$1', $files[$i]);
  @unlink($iconsDir."icon-512-$oldVer.png");
  @unlink($iconsDir."icon-512-maskable-$oldVer.png");
  @unlink($iconsDir."apple-touch-icon-$oldVer.png");
  @unlink($files[$i]);
}

// Reescreve manifest.webmanifest com as novas URLs
$manifestData = [
  "name" => $siteName,
  "short_name" => $shortName,
  "description" => "Mapa elétrico com KMZ/KML, filtros e busca – online e offline.",
  "start_url" => "index.html",
  "scope" => "./",
  "display" => "standalone",
  "orientation" => "any",
  "background_color" => "#0d1117",
  "theme_color" => "#0d6efd",
  "icons" => [
    [ "src" => "assets/icons/icon-192-$ver.png", "sizes"=>"192x192", "type"=>"image/png" ],
    [ "src" => "assets/icons/icon-512-$ver.png", "sizes"=>"512x512", "type"=>"image/png" ],
    [ "src" => "assets/icons/icon-512-maskable-$ver.png", "sizes"=>"512x512", "type"=>"image/png", "purpose"=>"maskable" ]
  ],
  "shortcuts" => [
    [
      "name"=>"Ver Mapa","short_name"=>"Mapa","url"=>"index.html",
      "icons"=>[[ "src"=>"assets/icons/icon-192-$ver.png","sizes"=>"192x192","type"=>"image/png" ]]
    ],
    [
      "name"=>"Abrir Admin","short_name"=>"Admin","url"=>"admin.html",
      "icons"=>[[ "src"=>"assets/icons/icon-192-$ver.png","sizes"=>"192x192","type"=>"image/png" ]]
    ]
  ]
];
file_put_contents($manifest, json_encode($manifestData, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));

// Resposta
echo json_encode([
  'ok'   => true,
  'version' => $ver,
  'icons' => [
    'icon192' => "assets/icons/icon-192-$ver.png",
    'icon512' => "assets/icons/icon-512-$ver.png",
    'mask512' => "assets/icons/icon-512-maskable-$ver.png",
    'apple'   => "assets/icons/apple-touch-icon-$ver.png",
  ],
  'manifest' => "manifest.webmanifest?v=$ver",
  'favicon'  => "uploads/logo.png?v=$ver"
]);
