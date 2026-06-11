import 'dart:convert';

String canonicalJson(Object? value) {
  if (value == null || value is String || value is num || value is bool) {
    return jsonEncode(value);
  }
  if (value is List<Object?>) {
    return '[${value.map(canonicalJson).join(',')}]';
  }
  if (value is Map<String, Object?>) {
    final keys = value.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${canonicalJson(value[key])}').join(',')}}';
  }
  throw ArgumentError.value(value, 'value', 'Unsupported JSON value');
}
