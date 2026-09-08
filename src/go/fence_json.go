package oreslocks

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// UnmarshalJSON is the strict wire boundary for a fenced write request.
// Unknown keys, trailing JSON, wrong runtime types, explicit empty optional
// metadata, and malformed tokens fail before the receiver is changed.
func (r *FencedWriteRequest) UnmarshalJSON(data []byte) error {
	type wireRequest struct {
		TenantScope   *string           `json:"tenantScope"`
		ResourceKey   *string           `json:"resourceKey"`
		FencingToken  *FencingTokenText `json:"fencingToken"`
		OperationID   *string           `json:"operationId"`
		PayloadSHA256 *string           `json:"payloadSha256"`
		Holder        *string           `json:"holder"`
		LeaseID       *string           `json:"leaseId"`
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var wire wireRequest
	if err := decoder.Decode(&wire); err != nil {
		code := "invalid_type"
		if strings.HasPrefix(err.Error(), "json: unknown field ") {
			code = "unexpected_field"
		}
		return FenceValidationError{
			Code:    code,
			Message: "invalid fenced write JSON: " + err.Error(),
		}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return FenceValidationError{
			Code:    "invalid_type",
			Message: "fenced write JSON must contain exactly one object",
		}
	}

	if wire.TenantScope == nil || wire.ResourceKey == nil ||
		wire.FencingToken == nil || wire.OperationID == nil ||
		wire.PayloadSHA256 == nil {
		return FenceValidationError{
			Code:    "invalid_type",
			Message: "fenced write JSON is missing a required field",
		}
	}
	if wire.Holder != nil && *wire.Holder == "" {
		return FenceValidationError{
			Code:    FenceValidationEmptyField,
			Field:   "holder",
			Message: "holder must not be empty when present",
		}
	}
	if wire.LeaseID != nil && *wire.LeaseID == "" {
		return FenceValidationError{
			Code:    FenceValidationEmptyField,
			Field:   "leaseId",
			Message: "leaseId must not be empty when present",
		}
	}

	key, err := NewLockKey(*wire.ResourceKey)
	if err != nil {
		return FenceValidationError{
			Code:    FenceValidationTooLong,
			Field:   "resourceKey",
			Message: err.Error(),
		}
	}
	holder := ""
	if wire.Holder != nil {
		holder = *wire.Holder
	}
	leaseID := ""
	if wire.LeaseID != nil {
		leaseID = *wire.LeaseID
	}
	parsed, err := NewFencedWriteRequest(
		*wire.TenantScope,
		key,
		*wire.FencingToken,
		*wire.OperationID,
		*wire.PayloadSHA256,
		holder,
		leaseID,
	)
	if err != nil {
		return err
	}
	*r = parsed
	return nil
}
