package io.gr3.transfer.core;
import java.util.*;
/** Strict, bounded parser for untrusted camera responses. No code or URLs are executed. */
public final class BoundedJson {
    private final String text;
    private int position, tokens;
    private BoundedJson(String text) { this.text = text; }
    public static Object parse(String text) throws TransferException {
        if (text.length() > CameraRules.MAX_JSON_BYTES) throw new TransferException("相机响应过大，已停止读取。");
        BoundedJson parser = new BoundedJson(text);
        Object result = parser.value(0); parser.space();
        if (parser.position != text.length()) parser.fail();
        return result;
    }
    private void fail() throws TransferException { throw new TransferException("相机响应不完整或格式有误，请重新连接后重试。"); }
    private void space() { while (position < text.length() && " \r\n\t".indexOf(text.charAt(position)) >= 0) position++; }
    private boolean take(char c) { space(); if (position < text.length() && text.charAt(position) == c) { position++; return true; } return false; }
    private Object value(int depth) throws TransferException {
        space();
        if (depth > 16 || ++tokens > 200000 || position >= text.length()) fail();
        char c = text.charAt(position);
        if (c == '"') return string();
        if (c == '{') {
            position++; Map<String,Object> map = new LinkedHashMap<>();
            if (take('}')) return map;
            do { space(); if (position >= text.length() || text.charAt(position) != '"') fail(); String key = string(); if (!take(':') || map.containsKey(key)) fail(); map.put(key, value(depth + 1)); } while (take(','));
            if (!take('}')) fail(); return map;
        }
        if (c == '[') {
            position++; List<Object> list = new ArrayList<>();
            if (take(']')) return list;
            do { list.add(value(depth + 1)); } while (take(','));
            if (!take(']')) fail(); return list;
        }
        for (String keyword : new String[]{"true", "false", "null"}) if (text.startsWith(keyword, position)) { position += keyword.length(); return keyword.equals("null") ? null : keyword.equals("true"); }
        int start = position;
        while (position < text.length() && "-+0123456789.eE".indexOf(text.charAt(position)) >= 0) position++;
        String number = text.substring(start, position);
        if (!number.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) fail();
        try { double n = Double.parseDouble(number); if (!Double.isFinite(n)) fail(); return n; } catch (NumberFormatException e) { fail(); return null; }
    }
    private String string() throws TransferException {
        position++; StringBuilder out = new StringBuilder();
        while (position < text.length()) {
            char c = text.charAt(position++);
            if (c == '"') return out.toString();
            if (c < 32) fail();
            if (c == '\\') {
                if (position >= text.length()) fail(); c = text.charAt(position++);
                switch (c) {
                    case '"': case '\\': case '/': break;
                    case 'b': c = '\b'; break; case 'f': c = '\f'; break;
                    case 'n': c = '\n'; break; case 'r': c = '\r'; break; case 't': c = '\t'; break;
                    case 'u':
                        if (position + 4 > text.length() || !text.substring(position, position + 4).matches("[0-9a-fA-F]{4}")) fail();
                        try { c = (char) Integer.parseInt(text.substring(position, position + 4), 16); } catch (NumberFormatException e) { fail(); }
                        position += 4; break;
                    default: fail();
                }
            }
            out.append(c);
            if (out.length() > 8192) fail();
        }
        fail(); return "";
    }
}
