package com.ss2do.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		forwardSharedImageIntent(getIntent());
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		forwardSharedImageIntent(intent);
	}

	private void forwardSharedImageIntent(Intent intent) {
		if (intent == null) {
			return;
		}

		String action = intent.getAction();
		String type = intent.getType();
		if (type == null || !type.startsWith("image/")) {
			return;
		}

		Uri imageUri = null;
		if (Intent.ACTION_SEND.equals(action)) {
			imageUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
		} else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
			java.util.ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
			if (uris != null && !uris.isEmpty()) {
				imageUri = uris.get(0);
			}
		}

		if (imageUri == null || bridge == null || bridge.getWebView() == null) {
			return;
		}

		String dataUrl = toDataUrl(imageUri);
		if (dataUrl == null || dataUrl.isEmpty()) {
			return;
		}

		final String safeSource = escapeForJs(dataUrl);
		bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(
			"window.__SS2DO_PENDING_SHARED_IMAGE_URI='" + safeSource + "';" +
			"window.dispatchEvent(new CustomEvent('ss2do-share-image',{detail:{uri:'" + safeSource + "'}}));",
			null
		));
	}

	private String toDataUrl(Uri uri) {
		try (InputStream input = getContentResolver().openInputStream(uri);
			 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
			if (input == null) {
				return null;
			}

			byte[] buffer = new byte[8192];
			int read;
			while ((read = input.read(buffer)) != -1) {
				output.write(buffer, 0, read);
			}

			String mime = getContentResolver().getType(uri);
			if (mime == null || mime.isEmpty()) {
				mime = "image/png";
			}

			String base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
			return "data:" + mime + ";base64," + base64;
		} catch (Exception ignored) {
			return null;
		}
	}

	private String escapeForJs(String value) {
		return value.replace("\\", "\\\\").replace("'", "\\'");
	}
}
