import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:feral_file_art_computer_handoff/src/client.dart';
import 'package:feral_file_art_computer_handoff/src/handoff_payload.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HandoffPayload validPayload() {
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
  test('submits ciphertext shape and never plaintext', () async {
    late Map<String, Object?> submitted;
    final client = ArtComputerHandoffClient(
      httpClient: MockClient((http.Request request) async {
        submitted = jsonDecode(request.body) as Map<String, Object?>;
        expect(request.url.path, '/v1/sessions/sid/payload');
        expect(request.body.contains('secret'), isFalse);
        return http.Response('{"status":"delivered"}', 201);
      }),
    );
    final payload = validPayload();
    await client.encryptAndSubmit(
      relayerBaseUri: Uri.parse('http://localhost:3000'),
      handoffPayload: payload,
      plaintext: Uint8List.fromList(utf8.encode('secret')),
    );
    final submittedPayload = submitted['payload']! as Map<String, Object?>;
    expect(submittedPayload['algorithm'], algorithm);
    expect(submittedPayload['ciphertext'], isA<String>());
    expect(submittedPayload['devicePublicKeyJwk'], isA<Map<String, Object?>>());
  });
}
