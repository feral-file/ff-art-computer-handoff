import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'crypto.dart';
import 'handoff_payload.dart';

final class EncryptedSubmitResult {
  const EncryptedSubmitResult({required this.sid});

  final String sid;
}

final class ArtComputerHandoffClient {
  const ArtComputerHandoffClient({http.Client? httpClient})
      : _httpClient = httpClient;

  final http.Client? _httpClient;

  Future<EncryptedSubmitResult> encryptAndSubmit({
    required Uri relayerBaseUri,
    required HandoffPayload handoffPayload,
    required Uint8List plaintext,
    String? expectedOrigin,
  }) async {
    handoffPayload.validate(expectedOrigin: expectedOrigin);
    final encrypted = await encryptPayload(
        handoffPayload: handoffPayload, plaintext: plaintext);
    final client = _httpClient ?? http.Client();
    final response = await client.post(
      relayerBaseUri.resolve('/v1/sessions/${handoffPayload.sid}/payload'),
      headers: <String, String>{'content-type': 'application/json'},
      body: jsonEncode(<String, Object?>{
        'payload': <String, Object?>{
          'algorithm': algorithm,
          'devicePublicKeyJwk': encrypted.devicePublicKeyJwk,
          'nonce': encrypted.nonce,
          'aad': encrypted.aad,
          'ciphertext': encrypted.ciphertext,
        },
      }),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw http.ClientException(
          'Submit failed: ${response.statusCode}', relayerBaseUri);
    }
    return EncryptedSubmitResult(sid: handoffPayload.sid);
  }
}
