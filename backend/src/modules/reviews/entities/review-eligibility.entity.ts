import { ApiProperty } from '@nestjs/swagger';

// Returned by GET /reviews/eligibility so the frontend can show or hide the
// "Write a Review" control without provoking a failed POST.
export class ReviewEligibilityEntity {
  @ApiProperty()
  eligible!: boolean;

  @ApiProperty({ required: false, nullable: true, description: 'Why the customer is not eligible, when eligible is false' })
  reason!: string | null;
}
