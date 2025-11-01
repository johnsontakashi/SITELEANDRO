<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');

$lat = isset($_GET['lat']) ? $_GET['lat'] : '';
$lon = isset($_GET['lon']) ? $_GET['lon'] : '';
if ($lat === '' || $lon === '') { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'lat/lon obrigatórios']); exit; }

$u = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=".urlencode($lat)."&lon=".urlencode($lon)."&accept-language=pt-BR";
$ch = curl_init($u);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_USERAGENT => 'GeoViewerPro/1.0 (contato@seu-dominio.com)',
  CURLOPT_TIMEOUT => 10
]);
$resp = curl_exec($ch);
$err  = curl_error($ch);
curl_close($ch);

if ($resp === false) { http_response_code(502); echo json_encode(['ok'=>false,'error'=>$err ?: 'upstream']); exit; }

$j = json_decode($resp, true);
$addr = $j['address'] ?? [];
$out = [
  'ok' => true,
  'city' => $addr['city'] ?? $addr['town'] ?? $addr['village'] ?? $addr['municipality'] ?? null,
  'admin1' => $addr['state'] ?? null,
  'country_code' => $addr['country_code'] ?? null,
  'raw' => $j
];
echo json_encode($out);
