Two sites must never share one storage root. Give each deployment its own `READSMITH_STORAGE_ROOT`; sharing one directory makes the second site overwrite the first site's compiled bundle.
