import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { applyTag, createTag, updateTag } from "./commands/tags.js";
import { addComment, createThread, deleteComment, editComment, reopenThread, resolveThread, subscribe } from "./commands/threads.js";
import { ApplyTagDto, CommentDto, CreateTagDto, CreateThreadDto, ListThreadsQueryDto, PeopleQueryDto, ReactionDto, SubscriptionDto, UpdateCommentDto, UpdateTagDto } from "./dto.js";
import { listPeople, listTags, listThreads } from "./queries.js";
import { addReaction, removeReaction } from "./commands/reactions.js";

/**
 * Threads, comments, subscriptions and tags (spec §13, §17 `threads` and `tags`). Entity routes take
 * the workspace from X-Workspace-Id. Reading or commenting needs `thread.comment` in the anchor's
 * scope; resolving is decided per thread (author, anchor owner, eligible approver, admin).
 */
@Controller()
export class ThreadsController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Get("threads")
  @Permission("thread.comment")
  list(@Tenant() auth: AuthContext, @Query() query: ListThreadsQueryDto) {
    return listThreads(this.prisma, auth, query);
  }

  @Post("threads")
  @Permission("thread.comment")
  create(@Tenant() auth: AuthContext, @Body() body: CreateThreadDto) {
    return createThread(this.prisma, auth, body);
  }

  @Post("threads/:id/comments")
  @Permission("thread.comment")
  comment(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: CommentDto) {
    return addComment(this.prisma, auth, id, body);
  }

  @Patch("comments/:id")
  @Permission("thread.comment")
  edit(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateCommentDto) {
    return editComment(this.prisma, auth, id, body);
  }

  @Delete("comments/:id")
  @Permission("thread.comment")
  remove(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return deleteComment(this.prisma, auth, id);
  }

  @Post("comments/:id/reactions")
  @Permission("thread.comment")
  react(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: ReactionDto) {
    return addReaction(this.prisma, auth, id, body);
  }

  @Delete("comments/:id/reactions")
  @Permission("thread.comment")
  unreact(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: ReactionDto) {
    return removeReaction(this.prisma, auth, id, body);
  }

  @Get("workspaces/:ws/people")
  @Permission("workspace.member")
  people(@Tenant() auth: AuthContext, @Query() query: PeopleQueryDto) {
    return listPeople(this.prisma, auth, query);
  }

  @Post("threads/:id/resolve")
  @Permission("thread.comment")
  resolve(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return resolveThread(this.prisma, auth, id);
  }

  @Post("threads/:id/reopen")
  @Permission("thread.comment")
  reopen(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return reopenThread(this.prisma, auth, id);
  }

  @Post("subscriptions")
  @Permission("workspace.member")
  subscribe(@Tenant() auth: AuthContext, @Body() body: SubscriptionDto) {
    return subscribe(this.prisma, auth, body);
  }

  @Get("workspaces/:ws/tags")
  @Permission("workspace.member")
  tags(@Tenant() auth: AuthContext) {
    return listTags(this.prisma, auth);
  }

  @Post("workspaces/:ws/tags")
  @Permission("tag.create")
  createTag(@Tenant() auth: AuthContext, @Body() body: CreateTagDto) {
    return createTag(this.prisma, auth, body);
  }

  @Patch("tags/:id")
  @Permission("tag.create")
  updateTag(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: UpdateTagDto) {
    return updateTag(this.prisma, auth, id, body);
  }

  @Post("tags/apply")
  @Permission("tag.apply")
  apply(@Tenant() auth: AuthContext, @Body() body: ApplyTagDto) {
    return applyTag(this.prisma, auth, body, "add");
  }

  @Delete("tags/apply")
  @Permission("tag.apply")
  unapply(@Tenant() auth: AuthContext, @Body() body: ApplyTagDto) {
    return applyTag(this.prisma, auth, body, "remove");
  }
}
