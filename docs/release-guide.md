# Release guide

This is a release process and checklist. It is **not standing authorization for
any future production deployment**. Do not report a release as ready until the
required review, checks, publish, and runtime verification below have succeeded.

## Release checklist

1. Push the working branch and open a pull request.
2. Review the complete diff. Confirm the relevant tests, typecheck, build, and
   pull request CI all pass; resolve review feedback before merging.
3. Merge only after the required reviews and checks succeed.
4. The existing
   [GHCR publish workflow](../.github/workflows/publish-ghcr.yml) starts on a
   push to `main`, including a merge. Let that run; do not start a duplicate
   workflow unless there is a specific reason.
5. Wait for the publish workflow to succeed. Record the release commit SHA, the
   published GHCR image reference, and its exact immutable image digest. Use
   that digest for deployment; a mutable tag such as `latest` alone does not
   identify the image precisely.
6. Before changing the service, record its currently deployed image reference
   and digest for rollback. Pull the published image by its recorded digest,
   then recreate **only** the `hubstaff-mcp` container with that ready image.
   Do not build the image locally. Preserve its existing volumes, secrets,
   environment configuration, and networks. Do not prune resources or change,
   restart, or recreate other services.
7. Verify that the running container uses the expected image digest and release
   revision. Check container health and inspect only safe structured logs; do
   not expose credentials or sensitive task data. Through an already authorized
   MCP client, run the read-only `hubstaff_list_tasks` smoke check with
   `organization_id=405914` and `max_items=1000`.
8. Mark the release ready only after these checks succeed. If deployment or
   verification fails, use the previously recorded image to plan a rollback
   under the applicable authorization; this checklist does not authorize that
   action either.
