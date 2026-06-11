import 'package:flutter_test/flutter_test.dart';
import 'package:feral_file_art_computer_handoff/src/handoff_payload.dart';

HandoffPayload fixturePayload({String? code, String? exp}) {
  final payload = HandoffPayload(
    v: 1,
    origin: 'https://example.com',
    sid: 'sid',
    exp: exp ??
        DateTime.now()
            .toUtc()
            .add(const Duration(minutes: 2))
            .toIso8601String(),
    alg: algorithm,
    bpub: const <String, Object?>{
      'kty': 'EC',
      'crv': 'P-256',
      'x': 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
      'y': 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU'
    },
    code: code ?? '',
  );
  return HandoffPayload(
    v: payload.v,
    origin: payload.origin,
    sid: payload.sid,
    exp: payload.exp,
    alg: payload.alg,
    bpub: payload.bpub,
    code: code ?? payload.expectedCheckCode(),
  );
}

void main() {
  test('parses and validates handoff payloads', () {
    final payload = fixturePayload();
    final parsed = HandoffPayload.fromJson(payload.toJson());
    expect(parsed.sid, 'sid');
    expect(() => parsed.validate(expectedOrigin: 'https://example.com'),
        returnsNormally);
  });

  test('rejects expired payloads and bad check codes', () {
    expect(
      () => fixturePayload(
              exp: DateTime.now()
                  .toUtc()
                  .subtract(const Duration(seconds: 1))
                  .toIso8601String())
          .validate(),
      throwsFormatException,
    );
    expect(() => fixturePayload(code: 'bad').validate(), throwsFormatException);
  });
}
