import { Module } from "@nestjs/common";
import { EnvelopesController } from "./envelopes.controller.js";
import { EnvelopesService } from "./envelopes.service.js";

@Module({ controllers: [EnvelopesController], providers: [EnvelopesService] })
export class EnvelopesModule {}
