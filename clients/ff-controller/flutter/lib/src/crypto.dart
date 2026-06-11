import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

import 'canonical_json.dart';
import 'handoff_payload.dart';

final class EncryptedPayload {
  const EncryptedPayload({
    required this.devicePublicKeyJwk,
    required this.nonce,
    required this.aad,
    required this.ciphertext,
  });

  final Map<String, Object?> devicePublicKeyJwk;
  final String nonce;
  final String aad;
  final String ciphertext;
}

Uint8List _jwkCoordinate(Map<String, Object?> jwk, String name) {
  final value = jwk[name];
  if (value is! String) {
    throw FormatException('Missing JWK coordinate $name');
  }
  return base64UrlNoPadDecode(value);
}

SecureRandom _secureRandom() {
  final random = Random.secure();
  final seed = Uint8List.fromList(
    List<int>.generate(32, (_) => random.nextInt(256), growable: false),
  );
  return FortunaRandom()..seed(KeyParameter(seed));
}

Uint8List _randomBytes(int length) {
  final random = Random.secure();
  return Uint8List.fromList(
    List<int>.generate(length, (_) => random.nextInt(256), growable: false),
  );
}

Uint8List _bigIntToFixedBytes(BigInt value, int length) {
  final result = Uint8List(length);
  var remaining = value;
  for (var i = length - 1; i >= 0; i -= 1) {
    result[i] = (remaining & BigInt.from(0xff)).toInt();
    remaining = remaining >> 8;
  }
  return result;
}

BigInt _bytesToBigInt(Uint8List bytes) {
  var result = BigInt.zero;
  for (final byte in bytes) {
    result = (result << 8) | BigInt.from(byte);
  }
  return result;
}

Uint8List _hkdfSha256({
  required Uint8List sharedSecret,
  required Uint8List salt,
  required Uint8List info,
}) {
  final hkdf = HKDFKeyDerivator(SHA256Digest())
    ..init(HkdfParameters(sharedSecret, 32, salt, info));
  return hkdf.process(Uint8List(0));
}

Uint8List _aesGcmEncrypt({
  required Uint8List key,
  required Uint8List nonce,
  required Uint8List aad,
  required Uint8List plaintext,
}) {
  final cipher = GCMBlockCipher(AESEngine())
    ..init(true, AEADParameters(KeyParameter(key), 128, nonce, aad));
  final output = Uint8List(cipher.getOutputSize(plaintext.length));
  final processed =
      cipher.processBytes(plaintext, 0, plaintext.length, output, 0);
  final finalBytes = cipher.doFinal(output, processed);
  return Uint8List.sublistView(output, 0, processed + finalBytes);
}

Future<EncryptedPayload> encryptPayload({
  required HandoffPayload handoffPayload,
  required Uint8List plaintext,
}) async {
  handoffPayload.validate();
  final domain = ECDomainParameters('prime256v1');
  final generator = ECKeyGenerator()
    ..init(
      ParametersWithRandom<ECKeyGeneratorParameters>(
        ECKeyGeneratorParameters(domain),
        _secureRandom(),
      ),
    );
  final keyPair = generator.generateKeyPair();
  final privateKey = keyPair.privateKey;
  final publicKey = keyPair.publicKey;
  final remotePublicKey = domain.curve.createPoint(
    _bytesToBigInt(_jwkCoordinate(handoffPayload.bpub, 'x')),
    _bytesToBigInt(_jwkCoordinate(handoffPayload.bpub, 'y')),
  );
  final sharedPoint = remotePublicKey * privateKey.d!;
  final sharedX = sharedPoint?.x?.toBigInteger();
  if (sharedX == null) {
    throw StateError('ECDH shared point was invalid');
  }
  final aadBytes =
      Uint8List.fromList(utf8.encode(canonicalJson(handoffPayload.aadJson())));
  final salt = Uint8List.fromList(crypto.sha256.convert(aadBytes).bytes);
  final aesKey = _hkdfSha256(
    sharedSecret: _bigIntToFixedBytes(sharedX, 32),
    salt: salt,
    info: Uint8List.fromList(utf8.encode('ff-art-computer-handoff/v1/aes-gcm')),
  );
  final nonce = _randomBytes(12);
  final ciphertext = _aesGcmEncrypt(
    key: aesKey,
    nonce: nonce,
    aad: aadBytes,
    plaintext: plaintext,
  );
  final publicPoint = publicKey.Q;
  final publicX = publicPoint?.x?.toBigInteger();
  final publicY = publicPoint?.y?.toBigInteger();
  if (publicX == null || publicY == null) {
    throw StateError('Generated P-256 public key was invalid');
  }
  return EncryptedPayload(
    devicePublicKeyJwk: <String, Object?>{
      'kty': 'EC',
      'crv': 'P-256',
      'x': base64UrlNoPad(_bigIntToFixedBytes(publicX, 32)),
      'y': base64UrlNoPad(_bigIntToFixedBytes(publicY, 32)),
      'ext': true,
    },
    nonce: base64UrlNoPad(nonce),
    aad: base64UrlNoPad(aadBytes),
    ciphertext: base64UrlNoPad(ciphertext),
  );
}
