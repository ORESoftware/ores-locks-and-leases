package oreslocks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

const (
	// MaxFencedWriteJSONBytes bounds the untrusted wire projection before a
	// decoder allocates maps or strings. The typed contract itself is below 2KB.
	MaxFencedWriteJSONBytes = 4096

	// These codes are shared with the TypeScript and Dart untrusted-wire
	// adapters. The typed Go constructors continue to use the narrower core
	// validation vocabulary.
	FenceValidationInvalidType     = "invalid_type"
	FenceValidationUnexpectedField = "unexpected_field"
)

var fencedWriteJSONFields = map[string]struct{}{
	"tenantScope":   {},
	"resourceKey":   {},
	"fencingToken":  {},
	"operationId":   {},
	"payloadSha256": {},
	"holder":        {},
	"leaseId":       {},
}

// DecodeFencedWriteRequestJSON validates one untrusted JSON request without
// coercion or precision loss. Unknown and duplicate fields, numeric fencing
// tokens, null optionals, trailing values, invalid UTF-8, and overlarge bodies
// are rejected before a datastore call can occur.
func DecodeFencedWriteRequestJSON(data []byte) (FencedWriteRequest, error) {
	if len(data) == 0 || len(data) > MaxFencedWriteJSONBytes || !utf8.Valid(data) {
		return FencedWriteRequest{}, wireFenceError(
			FenceValidationInvalidType,
			"request",
			"fenced write request must be non-empty valid UTF-8 JSON within the size limit",
		)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return FencedWriteRequest{}, wireFenceError(
			FenceValidationInvalidType,
			"request",
			"fenced write request must be a JSON object",
		)
	}

	fields := make(map[string]json.RawMessage, len(fencedWriteJSONFields))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return FencedWriteRequest{}, wireFenceError(
				FenceValidationInvalidType,
				"request",
				"fenced write request contains an invalid object key",
			)
		}
		key, ok := keyToken.(string)
		if !ok {
			return FencedWriteRequest{}, wireFenceError(
				FenceValidationInvalidType,
				"request",
				"fenced write request contains a non-string object key",
			)
		}
		if _, allowed := fencedWriteJSONFields[key]; !allowed {
			return FencedWriteRequest{}, wireFenceError(
				FenceValidationUnexpectedField,
				key,
				fmt.Sprintf("fenced write request contains unknown field %q", key),
			)
		}
		if _, duplicate := fields[key]; duplicate {
			return FencedWriteRequest{}, wireFenceError(
				FenceValidationUnexpectedField,
				key,
				fmt.Sprintf("fenced write request contains duplicate field %q", key),
			)
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return FencedWriteRequest{}, wireFenceError(
				FenceValidationInvalidType,
				key,
				fmt.Sprintf("fenced write request field %q is not valid JSON", key),
			)
		}
		fields[key] = raw
	}

	if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
		return FencedWriteRequest{}, wireFenceError(
			FenceValidationInvalidType,
			"request",
			"fenced write request object is incomplete",
		)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return FencedWriteRequest{}, wireFenceError(
			FenceValidationInvalidType,
			"request",
			"fenced write request must contain exactly one JSON value",
		)
	}

	tenantScope, err := requiredJSONString(fields, "tenantScope", FenceValidationInvalidType)
	if err != nil {
		return FencedWriteRequest{}, err
	}
	resourceKeyText, err := requiredJSONString(fields, "resourceKey", FenceValidationInvalidType)
	if err != nil {
		return FencedWriteRequest{}, err
	}
	fencingTokenRaw, err := requiredJSONString(fields, "fencingToken", FenceValidationInvalidFencingToken)
	if err != nil {
		return FencedWriteRequest{}, err
	}
	operationID, err := requiredJSONString(fields, "operationId", FenceValidationInvalidType)
	if err != nil {
		return FencedWriteRequest{}, err
	}
	payloadSHA256, err := requiredJSONString(fields, "payloadSha256", FenceValidationInvalidPayloadSHA256)
	if err != nil {
		return FencedWriteRequest{}, err
	}
	holder, err := optionalJSONString(fields, "holder")
	if err != nil {
		return FencedWriteRequest{}, err
	}
	leaseID, err := optionalJSONString(fields, "leaseId")
	if err != nil {
		return FencedWriteRequest{}, err
	}

	if len(resourceKeyText) > MaxLockKeyBytes {
		return FencedWriteRequest{}, FenceValidationError{
			Code:  FenceValidationTooLong,
			Field: "resourceKey",
			Message: fmt.Sprintf(
				"resourceKey is %d bytes; maximum is %d",
				len(resourceKeyText),
				MaxLockKeyBytes,
			),
		}
	}
	resourceKey, err := NewLockKey(resourceKeyText)
	if err != nil {
		return FencedWriteRequest{}, wireFenceError(
			FenceValidationInvalidType,
			"resourceKey",
			err.Error(),
		)
	}
	fencingToken, err := ParseFencingTokenText(fencingTokenRaw)
	if err != nil {
		return FencedWriteRequest{}, err
	}

	return NewFencedWriteRequest(
		tenantScope,
		resourceKey,
		fencingToken,
		operationID,
		payloadSHA256,
		holder,
		leaseID,
	)
}

func requiredJSONString(
	fields map[string]json.RawMessage,
	field string,
	wrongTypeCode string,
) (string, error) {
	raw, ok := fields[field]
	if !ok {
		return "", wireFenceError(
			FenceValidationInvalidType,
			field,
			fmt.Sprintf("%s must be an own JSON string field", field),
		)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", wireFenceError(
			wrongTypeCode,
			field,
			fmt.Sprintf("%s must be a JSON string", field),
		)
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", wireFenceError(
			wrongTypeCode,
			field,
			fmt.Sprintf("%s must be a valid JSON string", field),
		)
	}
	return value, nil
}

func optionalJSONString(
	fields map[string]json.RawMessage,
	field string,
) (string, error) {
	_, ok := fields[field]
	if !ok {
		return "", nil
	}
	value, err := requiredJSONString(fields, field, FenceValidationInvalidType)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", wireFenceError(
			FenceValidationEmptyField,
			field,
			fmt.Sprintf("%s must not be empty when present", field),
		)
	}
	return value, nil
}

func wireFenceError(code, field, message string) FenceValidationError {
	return FenceValidationError{Code: code, Field: field, Message: message}
}
