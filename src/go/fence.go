package oreslocks

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	// MaxFencingTokenText is the largest canonical token accepted on wire and
	// storage boundaries. It is uint64 max, represented without precision loss.
	MaxFencingTokenText = "18446744073709551615"

	// MaxTenantScopeBytes and MaxOperationIDBytes mirror the peer contracts.
	MaxTenantScopeBytes   = 256
	MaxOperationIDBytes   = 128
	MaxFenceMetadataBytes = 256
)

// FencingTokenText is canonical unsigned-64 decimal text. Its fields are
// private so callers cannot construct a malformed token without validation.
// JSON and Redis boundaries should use this form; native uint64 is safe only
// inside runtimes.
type FencingTokenText struct {
	text  string
	value uint64
}

// ParseFencingTokenText rejects signs, whitespace, leading zeroes, decimal
// points, and values outside uint64.
func ParseFencingTokenText(value string) (FencingTokenText, error) {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value {
		return FencingTokenText{}, FenceValidationError{
			Code:    FenceValidationInvalidFencingToken,
			Field:   "fencingToken",
			Message: fmt.Sprintf("fencing token %q is not a canonical unsigned-64 decimal string", value),
		}
	}
	return FencingTokenText{text: value, value: parsed}, nil
}

// FencingTokenTextFromUint64 returns the canonical lossless wire form.
func FencingTokenTextFromUint64(value uint64) FencingTokenText {
	return FencingTokenText{text: strconv.FormatUint(value, 10), value: value}
}

// String returns the canonical wire/storage representation.
func (t FencingTokenText) String() string { return t.text }

// Uint64 returns the exact native value. Only validated constructors can set it.
func (t FencingTokenText) Uint64() uint64 { return t.value }

// MarshalJSON always emits a JSON string, never a lossy JSON number.
func (t FencingTokenText) MarshalJSON() ([]byte, error) {
	if _, err := ParseFencingTokenText(t.text); err != nil {
		return nil, err
	}
	return json.Marshal(t.text)
}

// UnmarshalJSON accepts only a JSON string containing canonical token text.
func (t *FencingTokenText) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return FenceValidationError{
			Code:    FenceValidationInvalidFencingToken,
			Field:   "fencingToken",
			Message: "fencingToken must be a canonical unsigned-64 decimal JSON string",
		}
	}
	parsed, err := ParseFencingTokenText(text)
	if err != nil {
		return err
	}
	*t = parsed
	return nil
}

// FenceDecisionKind is the contract's decision vocabulary.
type FenceDecisionKind string

const (
	FenceAdvanced   FenceDecisionKind = "advanced"
	FenceReplay     FenceDecisionKind = "replay"
	FenceStale      FenceDecisionKind = "stale"
	FenceTokenReuse FenceDecisionKind = "token_reuse"
)

// FencedWriteRequest is one application mutation guarded by a Fiducia token.
type FencedWriteRequest struct {
	TenantScope   string           `json:"tenantScope"`
	ResourceKey   LockKey          `json:"resourceKey"`
	FencingToken  FencingTokenText `json:"fencingToken"`
	OperationID   string           `json:"operationId"`
	PayloadSHA256 string           `json:"payloadSha256"`
	Holder        string           `json:"holder,omitempty"`
	LeaseID       string           `json:"leaseId,omitempty"`
}

// NewFencedWriteRequest validates and builds a request.
func NewFencedWriteRequest(
	tenantScope string,
	resourceKey LockKey,
	fencingToken FencingTokenText,
	operationID string,
	payloadSHA256 string,
	holder string,
	leaseID string,
) (FencedWriteRequest, error) {
	request := FencedWriteRequest{
		TenantScope:   tenantScope,
		ResourceKey:   resourceKey,
		FencingToken:  fencingToken,
		OperationID:   operationID,
		PayloadSHA256: payloadSHA256,
		Holder:        holder,
		LeaseID:       leaseID,
	}
	if err := request.Validate(); err != nil {
		return FencedWriteRequest{}, err
	}
	return request, nil
}

// Validate fails closed for malformed or lossy input.
func (r FencedWriteRequest) Validate() error {
	if err := validateFenceField("tenantScope", r.TenantScope, MaxTenantScopeBytes, false); err != nil {
		return err
	}
	if err := validateFenceField("resourceKey", string(r.ResourceKey), MaxLockKeyBytes, false); err != nil {
		return err
	}
	if _, err := ParseFencingTokenText(r.FencingToken.String()); err != nil {
		return err
	}
	if err := validateFenceField("operationId", r.OperationID, MaxOperationIDBytes, false); err != nil {
		return err
	}
	if !isLowerSHA256(r.PayloadSHA256) {
		return FenceValidationError{
			Code:    FenceValidationInvalidPayloadSHA256,
			Field:   "payloadSha256",
			Message: "payloadSha256 must be exactly 64 lowercase hexadecimal characters",
		}
	}
	if err := validateFenceField("holder", r.Holder, MaxFenceMetadataBytes, true); err != nil {
		return err
	}
	if err := validateFenceField("leaseId", r.LeaseID, MaxFenceMetadataBytes, true); err != nil {
		return err
	}
	return nil
}

// FenceWatermark is the last accepted write for one tenant/resource identity.
type FenceWatermark struct {
	TenantScope   string           `json:"tenantScope"`
	ResourceKey   LockKey          `json:"resourceKey"`
	FencingToken  FencingTokenText `json:"fencingToken"`
	OperationID   string           `json:"operationId"`
	PayloadSHA256 string           `json:"payloadSha256"`
	Holder        string           `json:"holder,omitempty"`
	LeaseID       string           `json:"leaseId,omitempty"`
}

// WatermarkFromRequest produces the row to persist after an advanced decision.
func WatermarkFromRequest(request FencedWriteRequest) FenceWatermark {
	return FenceWatermark{
		TenantScope:   request.TenantScope,
		ResourceKey:   request.ResourceKey,
		FencingToken:  request.FencingToken,
		OperationID:   request.OperationID,
		PayloadSHA256: request.PayloadSHA256,
		Holder:        request.Holder,
		LeaseID:       request.LeaseID,
	}
}

// Validate fails closed for malformed persisted state.
func (w FenceWatermark) Validate() error {
	return FencedWriteRequest{
		TenantScope:   w.TenantScope,
		ResourceKey:   w.ResourceKey,
		FencingToken:  w.FencingToken,
		OperationID:   w.OperationID,
		PayloadSHA256: w.PayloadSHA256,
		Holder:        w.Holder,
		LeaseID:       w.LeaseID,
	}.Validate()
}

// FenceDecision is pure decision data. ShouldApply is true only for advanced.
type FenceDecision struct {
	Kind          FenceDecisionKind `json:"kind"`
	ShouldApply   bool              `json:"shouldApply"`
	IncomingToken FencingTokenText  `json:"incomingToken"`
	CurrentToken  FencingTokenText  `json:"currentToken"`
	PreviousToken *FencingTokenText `json:"previousToken,omitempty"`
}

// EvaluateFence compares a request with an optional current watermark.
//
// The datastore adapter must persist an advanced watermark and perform the
// protected mutation in the same transaction or Redis script.
func EvaluateFence(current *FenceWatermark, incoming FencedWriteRequest) (FenceDecision, error) {
	if err := incoming.Validate(); err != nil {
		return FenceDecision{}, err
	}

	if current == nil {
		return FenceDecision{
			Kind:          FenceAdvanced,
			ShouldApply:   true,
			IncomingToken: incoming.FencingToken,
			CurrentToken:  incoming.FencingToken,
		}, nil
	}
	if err := current.Validate(); err != nil {
		return FenceDecision{}, err
	}
	if current.TenantScope != incoming.TenantScope || current.ResourceKey != incoming.ResourceKey {
		return FenceDecision{}, FenceValidationError{
			Code:    FenceValidationIdentityMismatch,
			Message: "current watermark and incoming request identify different resources",
		}
	}

	previous := current.FencingToken
	incomingValue := incoming.FencingToken.Uint64()
	currentValue := current.FencingToken.Uint64()

	switch {
	case incomingValue > currentValue:
		return FenceDecision{
			Kind:          FenceAdvanced,
			ShouldApply:   true,
			IncomingToken: incoming.FencingToken,
			CurrentToken:  incoming.FencingToken,
			PreviousToken: &previous,
		}, nil
	case incomingValue < currentValue:
		return FenceDecision{
			Kind:          FenceStale,
			ShouldApply:   false,
			IncomingToken: incoming.FencingToken,
			CurrentToken:  current.FencingToken,
			PreviousToken: &previous,
		}, nil
	default:
		kind := FenceTokenReuse
		if current.OperationID == incoming.OperationID &&
			current.PayloadSHA256 == incoming.PayloadSHA256 {
			kind = FenceReplay
		}
		return FenceDecision{
			Kind:          kind,
			ShouldApply:   false,
			IncomingToken: incoming.FencingToken,
			CurrentToken:  current.FencingToken,
			PreviousToken: &previous,
		}, nil
	}
}

// Stable validation codes used by conformance tests and adapters.
const (
	FenceValidationEmptyField           = "empty_field"
	FenceValidationTooLong              = "too_long"
	FenceValidationInvalidFencingToken  = "invalid_fencing_token"
	FenceValidationInvalidPayloadSHA256 = "invalid_payload_sha256"
	FenceValidationIdentityMismatch     = "identity_mismatch"
)

// FenceValidationError is returned before a datastore mutation is attempted.
type FenceValidationError struct {
	Code    string
	Field   string
	Message string
}

func (e FenceValidationError) Error() string { return e.Message }

// FenceValidationCode extracts the stable code when err is a validation error.
func FenceValidationCode(err error) string {
	var validation FenceValidationError
	if errors.As(err, &validation) {
		return validation.Code
	}
	return ""
}

func validateFenceField(field, value string, max int, optional bool) error {
	if value == "" {
		if optional {
			return nil
		}
		return FenceValidationError{
			Code:    FenceValidationEmptyField,
			Field:   field,
			Message: field + " must not be empty",
		}
	}
	if len(value) > max {
		return FenceValidationError{
			Code:  FenceValidationTooLong,
			Field: field,
			Message: fmt.Sprintf(
				"%s is %d bytes; maximum is %d",
				field,
				len(value),
				max,
			),
		}
	}
	return nil
}

func isLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool {
		return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f'))
	}) == -1
}
