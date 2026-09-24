`DELETE /uploads/{uploadId}` now validates the id before any filesystem access — closes a path-traversal-to-arbitrary-deletion vulnerability in the server chat's upload cancel route
