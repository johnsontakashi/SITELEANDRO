<?php
// api/reverse_geocode.php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$lat = isset($_GET['lat']) ? floatval($_GET['lat']) : null;
$lng = isset($_GET['lng']) ? floatval($_GET['lng']) : null;
if ($lat === null || $lng === null) {
  http_response_code(400);
  echo json_encode(['ok'=>false,'error'=>'missing lat/lng']);
  exit;
}

// tentativas em ordem (Open-Meteo -> Maps.co)
$urls = [
  "https://geocoding-api.open-meteo.com/v1/reverse?latitude={$lat}&longitude={$lng}&language=pt&format=json",
  "https://geocode.maps.co/reverse?lat={$lat}&lon={$lng}&format=json"
];

foreach ($urls as $u) {
  $ch = curl_init($u);
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_TIMEOUT, 8);
  // se seu servidor não tiver CA bundle atualizado, descomente as linhas abaixo (não recomendado em prod):
  // curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
  // curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);

  $body = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);

  if ($code >= 200 && $code < 300 && $body) {
    $data = json_decode($body, true);

    // Open-Meteo
    if (isset($data['results'][0])) {
      $r = $data['results'][0];
      echo json_encode([
        'ok' => true,
        'city' => $r['name'] ?? null,
        'admin1' => $r['admin1'] ?? null,
        'country_code' => $r['country_code'] ?? null
      ]);
      exit;
    }

    // Maps.co (Nominatim)
    if (isset($data['address']) || isset($data['display_name'])) {
      $addr = $data['address'] ?? [];
      $city =
        $addr['city'] ?? $addr['town'] ?? $addr['village'] ??
        ($data['name'] ?? $data['display_name'] ?? null);

      echo json_encode([
        'ok' => true,
        'city' => $city,
        'admin1' => $addr['state'] ?? null,
        'country_code' => $addr['country_code'] ?? null
      ]);
      exit;
    }
  }
}

http_response_code(502);
echo json_encode(['ok'=>false,'error'=>'reverse geocode failed']);
