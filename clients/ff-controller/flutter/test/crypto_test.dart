import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:feral_file_art_computer_handoff/src/crypto.dart';
import 'package:feral_file_art_computer_handoff/src/handoff_payload.dart';

HandoffPayload cryptoPayload() {
  final unsigned = HandoffPayload(
    v: 1,
    origin: 'https://example.com',
    sid: 'sid',
    exp: DateTime.now()
        .toUtc()
        .add(const Duration(minutes: 2))
        .toIso8601String(),
    alg: algorithm,
    bpub: <String, Object?>{
      'kty': 'EC',
      'crv': 'P-256',
      'x': 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
      'y': 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
    },
    code: '',
  );
  return HandoffPayload(
    v: unsigned.v,
    origin: unsigned.origin,
    sid: unsigned.sid,
    exp: unsigned.exp,
    alg: unsigned.alg,
    bpub: unsigned.bpub,
    code: unsigned.expectedCheckCode(),
  );
}

void main() {
  test('encrypts with P-256, HKDF-SHA256, and AES-GCM submit fields', () async {
    final payload = cryptoPayload();
    final encrypted = await encryptPayload(
        handoffPayload: payload, plaintext: Uint8List.fromList(<int>[1, 2, 3]));
    expect(encrypted.devicePublicKeyJwk['crv'], 'P-256');
    expect(encrypted.nonce, isNotEmpty);
    expect(encrypted.aad, payload.aadBase64Url());
    expect(encrypted.ciphertext, isNotEmpty);
  });
}
