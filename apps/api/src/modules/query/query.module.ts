import { Module } from "@nestjs/common";
import { QueryController } from "./query.controller.js";

@Module({ controllers: [QueryController] })
export class QueryModule {}
