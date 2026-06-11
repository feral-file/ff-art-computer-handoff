import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

import 'canonical_json.dart';

const algorithm = 'P256-HKDF-SHA256-AES-256-GCM';
final _base64UrlNoPadRegex = RegExp(r'^[A-Za-z0-9_-]+$');
final _p256P = BigInt.parse(
  'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
  radix: 16,
);
final _p256B = BigInt.parse(
  '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b',
  radix: 16,
);

String base64UrlNoPad(Uint8List bytes) =>
    base64UrlEncode(bytes).replaceAll('=', '');

Uint8List base64UrlNoPadDecode(String value) {
  if (!_base64UrlNoPadRegex.hasMatch(value)) {
    throw const FormatException('Invalid base64url value');
  }
  final normalized = value.padRight((value.length + 3) ~/ 4 * 4, '=');
  return Uint8List.fromList(base64Url.decode(normalized));
}

final class HandoffPayload {
  const HandoffPayload({
    required this.v,
    required this.origin,
    required this.sid,
    required this.exp,
    required this.alg,
    required this.bpub,
    required this.code,
  });

  factory HandoffPayload.fromJson(Map<String, Object?> json) {
    final bpubValue = json['bpub'];
    if (bpubValue is! Map<String, Object?>) {
      throw const FormatException('bpub must be an object');
    }
    return HandoffPayload(
      v: _requireInt(json, 'v'),
      origin: _requireString(json, 'origin'),
      sid: _requireString(json, 'sid'),
      exp: _requireString(json, 'exp'),
      alg: _requireString(json, 'alg'),
      bpub: Map<String, Object?>.unmodifiable(bpubValue),
      code: _requireString(json, 'code'),
    );
  }

  factory HandoffPayload.parse(String source) {
    final decoded = jsonDecode(source);
    if (decoded is! Map<String, Object?>) {
      throw const FormatException('handoff payload must be a JSON object');
    }
    return HandoffPayload.fromJson(decoded);
  }

  final int v;
  final String origin;
  final String sid;
  final String exp;
  final String alg;
  final Map<String, Object?> bpub;
  final String code;

  Map<String, Object?> toJson() => <String, Object?>{
        'v': v,
        'origin': origin,
        'sid': sid,
        'exp': exp,
        'alg': alg,
        'bpub': bpub,
        'code': code,
      };

  Map<String, Object?> unsignedJson() => <String, Object?>{
        'v': v,
        'origin': origin,
        'sid': sid,
        'exp': exp,
        'alg': alg,
        'bpub': bpub,
      };

  Map<String, Object?> aadJson() => <String, Object?>{
        'alg': alg,
        'code': code,
        'exp': exp,
        'origin': origin,
        'sid': sid,
        'v': v,
      };

  String aadBase64Url() =>
      base64UrlNoPad(Uint8List.fromList(utf8.encode(canonicalJson(aadJson()))));

  String expectedCheckCode() {
    final bytes = utf8.encode(canonicalJson(unsignedJson()));
    final digest = crypto.sha256.convert(bytes).bytes;
    return base64UrlNoPad(Uint8List.fromList(digest.sublist(0, 8)));
  }

  void validate({String? expectedOrigin, DateTime? now}) {
    if (v != 1) {
      throw const FormatException('Unsupported handoff payload version');
    }
    if (alg != algorithm) {
      throw const FormatException('Unsupported handoff payload algorithm');
    }
    if (expectedOrigin != null && origin != expectedOrigin) {
      throw const FormatException('handoff payload origin mismatch');
    }
    final expiresAt = DateTime.parse(exp);
    if (!expiresAt.isAfter(now ?? DateTime.now().toUtc())) {
      throw const FormatException('handoff payload expired');
    }
    if (expectedCheckCode() != code) {
      throw const FormatException('handoff payload check code mismatch');
    }
    _validatePublicJwk(bpub);
  }
}

int _requireInt(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is int) {
    return value;
  }
  throw FormatException('$key must be an integer');
}

String _requireString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String) {
    return value;
  }
  throw FormatException('$key must be a string');
}

BigInt _bytesToBigInt(Uint8List bytes) {
  var result = BigInt.zero;
  for (final byte in bytes) {
    result = (result << 8) | BigInt.from(byte);
  }
  return result;
}

void _validatePublicJwk(Map<String, Object?> jwk) {
  const allowedKeys = <String>{'kty', 'crv', 'x', 'y', 'ext', 'key_ops'};
  for (final key in jwk.keys) {
    if (!allowedKeys.contains(key)) {
      throw FormatException('Unexpected JWK field $key');
    }
  }
  if (jwk['kty'] != 'EC' || jwk['crv'] != 'P-256') {
    throw const FormatException('handoff public key must be P-256 EC JWK');
  }
  final xValue = jwk['x'];
  final yValue = jwk['y'];
  if (xValue is! String || yValue is! String) {
    throw const FormatException('handoff public key missing coordinates');
  }
  final xBytes = base64UrlNoPadDecode(xValue);
  final yBytes = base64UrlNoPadDecode(yValue);
  if (xBytes.length != 32 || yBytes.length != 32) {
    throw const FormatException(
        'handoff public key coordinates must be 32 bytes');
  }
  final x = _bytesToBigInt(xBytes);
  final y = _bytesToBigInt(yBytes);
  if (x >= _p256P || y >= _p256P) {
    throw const FormatException('handoff public key coordinates out of range');
  }
  final left = (y * y) % _p256P;
  final right = ((x * x * x) - (BigInt.from(3) * x) + _p256B) % _p256P;
  if (left != right) {
    throw const FormatException('handoff public key is not on P-256');
  }
}
