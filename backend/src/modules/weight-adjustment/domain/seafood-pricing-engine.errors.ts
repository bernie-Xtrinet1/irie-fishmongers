export class WeightPricingEngineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'WeightPricingEngineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidPricingBasisError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'INVALID_PRICING_BASIS');
    this.name = 'InvalidPricingBasisError';
  }
}

export class InvalidWeightUnitError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'INVALID_WEIGHT_UNIT');
    this.name = 'InvalidWeightUnitError';
  }
}

export class NegativeWeightError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'NEGATIVE_WEIGHT');
    this.name = 'NegativeWeightError';
  }
}

export class ZeroWeightError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'ZERO_WEIGHT');
    this.name = 'ZeroWeightError';
  }
}

export class InvalidPrecisionError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'INVALID_PRECISION');
    this.name = 'InvalidPrecisionError';
  }
}

export class InvalidPriceError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'INVALID_PRICE');
    this.name = 'InvalidPriceError';
  }
}

export class InvalidPreparationFeeError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'INVALID_PREPARATION_FEE');
    this.name = 'InvalidPreparationFeeError';
  }
}

export class CeilingBelowEstimateError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'CEILING_BELOW_ESTIMATE');
    this.name = 'CeilingBelowEstimateError';
  }
}

export class PreparedWeightExceedsBillableError extends WeightPricingEngineError {
  constructor(message: string) {
    super(message, 'PREPARED_WEIGHT_EXCEEDS_BILLABLE');
    this.name = 'PreparedWeightExceedsBillableError';
  }
}
