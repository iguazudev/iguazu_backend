import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingConfig } from './billing.config';
import { InvoicesService } from './invoices.service';
import { XmlBuilderService } from './sunat/xml-builder.service';
import { XmlSignerService } from './sunat/xml-signer.service';
import { ZipService } from './sunat/zip.service';
import { SunatService } from './sunat/sunat.service';
import { UnzipCdrService } from './sunat/unzip-cdr.service';
import { PdfService } from './sunat/pdf.service';
import { SummaryBuilderService } from './sunat/summary-builder.service';
import { SummaryProcessorService } from './summary-processor.service';

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingConfig,
    InvoicesService,
    XmlBuilderService,
    XmlSignerService,
    ZipService,
    SunatService,
    UnzipCdrService,
    PdfService,
    SummaryBuilderService,
    SummaryProcessorService,
  ],
  exports: [BillingService, SummaryProcessorService],
})
export class BillingModule {}
