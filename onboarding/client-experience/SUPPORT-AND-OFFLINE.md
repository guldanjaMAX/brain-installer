# Support and offline recovery

The approved support contact and response targets live in
`support-profile.example.json` or the engagement-specific replacement. Response
targets are operational goals unless a signed agreement says otherwise.

## If setup or update stops

1. Keep the terminal open if possible and read the plain issue code.
2. Do not paste a stack trace, secret, private path, filename, source content,
   invite link, or authentication detail into chat.
3. Run the same supported setup or update command once more. The workflow is
   designed to resume safely.
4. Explain a named issue code locally:

   ```text
   brain support --explain <ISSUE_CODE>
   ```

5. Preview the private local support note:

   ```text
   brain support --preview
   ```

   Previewing sends nothing. The owner chooses whether to share a sanitized
   excerpt through the approved support channel.
6. If the internet is unavailable, save the issue code and time, keep the local
   manifest and support note private, and resume the same command after the
   connection returns.
7. Do not attempt rollback, deletion, token rotation, account transfer, or a
   replacement deployment without a technician's reviewed plan and the owner's
   approval.

## Plain recovery states

- **Interrupted:** rerun the same command. Do not start over.
- **Partial source:** keep the loaded portion visible and name what is missing.
- **Unavailable source:** say unavailable, not empty or complete.
- **Vector backlog:** keyword retrieval may exist, but meaning search is not
  accepted until the backlog reaches zero.
- **Update check unavailable:** the release feed could not be trusted. It does
  not prove the installed version is current.
- **Passkey problem:** keep the owner boundary closed and use the documented
  recovery ceremony. Do not bypass authentication.
- **Suspected exposure or unauthorized access:** stop mutation, preserve only
  safe evidence, and use the incident contact in the approved support profile.

## Support access boundary

The candidate gives support no standing access to the owner's Brain. An owner
can explicitly create a temporary read-only diagnostics session, review its
scope, see it in owner activity, revoke it, or let it expire. The initial
session cannot repair or mutate the Brain. Do not call this support path
live-proven until passkey enrollment, diagnostics access, revocation, and expiry
have passed against the final public hostname.
