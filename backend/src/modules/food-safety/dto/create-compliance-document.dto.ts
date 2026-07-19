import { ApiProperty } from '@nestjs/swagger';
import { ComplianceDocumentType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUrl } from 'class-validator';

// Exactly-one-of relatedLotId/relatedRecallId is enforced in the service
// (ComplianceDocumentsService.create), matching the same
// mutually-exclusive-input pattern already used by
// SeafoodLotsService.resolveLotSourceFields - not expressible cleanly as
// a class-validator decorator without also rejecting the legitimate
// "both omitted is invalid, but which one is required depends on the
// other" case.
export class CreateComplianceDocumentDto {
  @ApiProperty({ enum: ComplianceDocumentType })
  @IsEnum(ComplianceDocumentType)
  documentType!: ComplianceDocumentType;

  @ApiProperty({ required: false, description: 'Exactly one of relatedLotId/relatedRecallId must be set' })
  @IsOptional()
  @IsString()
  relatedLotId?: string;

  @ApiProperty({ required: false, description: 'Exactly one of relatedLotId/relatedRecallId must be set' })
  @IsOptional()
  @IsString()
  relatedRecallId?: string;

  @ApiProperty()
  @IsUrl()
  fileUrl!: string;
}
