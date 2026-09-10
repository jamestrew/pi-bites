# Present nested operations as ordinary tools

Reuse the five tools' existing renderers inside Code Mode results and hide raw JavaScript by default, preserving recognizable commands, patches, and other tool activity. Expansion exposes nested details; errors and images remain visible, and explicit script output is shown when there are no nested calls to display. This follows upstream's ordinary-tool presentation while avoiding its potentially empty display for successful standalone computations; UI visibility remains separate from model-visible output.
